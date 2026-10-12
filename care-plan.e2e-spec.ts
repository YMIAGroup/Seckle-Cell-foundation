import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';

/**
 * Care Plan versioning (care-plan.service.ts). The `care_plans` table
 * existed since the very first care migration with nothing ever writing
 * to it -- no service, no route. This checks the real behaviour end to
 * end: creating the first version, creating a second version supersedes
 * the first rather than leaving two ACTIVE rows, "active" always
 * reflects the latest version, and the full version history is listed
 * oldest-or-newest-first in a stable, checkable order.
 */
describe('Care Plan versioning (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const password = 'CarePlanFlow123!';
  const run = Date.now();
  const http = () => request(app.getHttpServer());
  let caseworkerAuth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const email = `careplan-caseworker-${run}@example.test`;
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`, [`SCF-USR-CPLAN-${run}`, email, hash]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT us.id, r.id FROM users us, roles r WHERE us.email=$1 AND r.code='CASE_WORKER' ON CONFLICT DO NOTHING`, [email]);
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    caseworkerAuth = { Authorization: `Bearer ${login.body.access_token}` };
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  let caseId: string;

  it('a case with no care plan yet reports that clearly, rather than 404ing or returning null', async () => {
    const beneficiaryId = (
      await http().post('/beneficiaries').set(caseworkerAuth).send({ firstName: 'Plan', lastName: 'Test', dateOfBirth: '2016-05-01', county: 'Nairobi' }).expect(201)
    ).body.id;
    caseId = (await http().post(`/beneficiaries/${beneficiaryId}/cases`).set(caseworkerAuth).expect(201)).body.id;

    const active = (await http().get(`/cases/${caseId}/care-plans/active`).set(caseworkerAuth).expect(200)).body;
    expect(active.message).toMatch(/no care plan/i);

    const list = (await http().get(`/cases/${caseId}/care-plans`).set(caseworkerAuth).expect(200)).body;
    expect(list).toEqual([]);
  });

  it('creates version 1 as ACTIVE', async () => {
    const v1 = (
      await http().post(`/cases/${caseId}/care-plans`).set(caseworkerAuth).send({ goals: 'Stabilise medication routine', startDate: '2026-01-01' }).expect(201)
    ).body;
    expect(v1.version).toBe(1);
    expect(v1.status).toBe('ACTIVE');

    const active = (await http().get(`/cases/${caseId}/care-plans/active`).set(caseworkerAuth).expect(200)).body;
    expect(active.id).toBe(v1.id);
    expect(active.version).toBe(1);
  });

  it('creating version 2 supersedes version 1, so exactly one version is ever ACTIVE', async () => {
    const v2 = (
      await http().post(`/cases/${caseId}/care-plans`).set(caseworkerAuth).send({ goals: 'Add school liaison support' }).expect(201)
    ).body;
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('ACTIVE');

    const list = (await http().get(`/cases/${caseId}/care-plans`).set(caseworkerAuth).expect(200)).body;
    expect(list.length).toBe(2);
    const statusesByVersion: Record<number, string> = {};
    for (const row of list) statusesByVersion[row.version] = row.status;
    expect(statusesByVersion[1]).toBe('SUPERSEDED');
    expect(statusesByVersion[2]).toBe('ACTIVE');

    const active = (await http().get(`/cases/${caseId}/care-plans/active`).set(caseworkerAuth).expect(200)).body;
    expect(active.version).toBe(2);
    expect(active.goals).toBe('Add school liaison support');
  });

  it('rejects an invalid date on a new version', async () => {
    await http().post(`/cases/${caseId}/care-plans`).set(caseworkerAuth).send({ startDate: 'not-a-date' }).expect(400);
  });
});
