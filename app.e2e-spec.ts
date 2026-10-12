import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';

/**
 * REAL end-to-end tests — these boot the full NestJS app against a
 * real Postgres instance. Prerequisites (see README):
 *   docker compose -f infra/docker/docker-compose.yml up -d
 *   npm run migrate && npm run seed
 *   DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET set in env
 *
 * These are the tests that were missing entirely before the HTTP
 * layer existed: everything prior was unit tests with mocked DBs, so
 * nothing had ever verified that guards, DTOs, controllers, and the
 * real schema actually work together.
 */
describe('SCCF API (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  const password = 'TestPassword123!';
  const donorEmail = 'e2e-donor@example.test';
  const caseWorkerEmail = 'e2e-caseworker@example.test';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();

    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const hash = await bcrypt.hash(password, 10);

    // Seed two test users with real bcrypt hashes and real role assignments.
    for (const [email, roleCode, ref] of [
      [donorEmail, 'DONOR', 'SCF-USR-E2EDNR'],
      [caseWorkerEmail, 'CASE_WORKER', 'SCF-USR-E2ECW'],
    ]) {
      await pool.query(
        `INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`,
        [ref, email, hash],
      );
      await pool.query(
        `INSERT INTO user_roles (user_id, role_id)
         SELECT u.id, r.id FROM users u, roles r WHERE u.email = $1 AND r.code = $2 ON CONFLICT DO NOTHING`,
        [email, roleCode],
      );
    }
  });

  afterAll(async () => {
    // Deliberately do NOT delete the test users: the login attempts above wrote
    // audit_events rows referencing them, and the audit trail is append-only by
    // design — the database (correctly) refuses to orphan those records. The users
    // are created idempotently (ON CONFLICT DO NOTHING), so leaving them is safe.
    await app.close();
    await pool.end();
  });

  async function login(email: string): Promise<string> {
    const res = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(201);
    return res.body.access_token;
  }

  it('rejects an unauthenticated request to a protected route', async () => {
    await request(app.getHttpServer()).post('/beneficiaries').send({}).expect(401);
  });

  it('rejects a login with a wrong password', async () => {
    await request(app.getHttpServer()).post('/auth/login').send({ email: donorEmail, password: 'wrong' }).expect(401);
  });

  it('a donor cannot reach the Care domain (create a beneficiary)', async () => {
    const token = await login(donorEmail);
    await request(app.getHttpServer())
      .post('/beneficiaries')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'X', dateOfBirth: '2017-01-01' })
      .expect(403);
  });

  it('a donor cannot reach the Clinical domain', async () => {
    const token = await login(donorEmail);
    await request(app.getHttpServer())
      .get('/clinical/beneficiaries/00000000-0000-0000-0000-000000000000/profile')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('a donor cannot confirm their own donation as received (FINANCE:WRITE required)', async () => {
    const token = await login(donorEmail);
    await request(app.getHttpServer())
      .post('/finance/donations/00000000-0000-0000-0000-000000000000/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({ externalReference: 'FAKE-REF' })
      .expect(403);
  });

  it('a case worker cannot reach the Finance domain', async () => {
    const token = await login(caseWorkerEmail);
    await request(app.getHttpServer())
      .post('/funds')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'x', fundType: 'GENERAL' })
      .expect(403);
  });

  it('DTO validation rejects an unknown property (forbidNonWhitelisted)', async () => {
    const token = await login(donorEmail);
    await request(app.getHttpServer())
      .post('/donor/sponsorships')
      .set('Authorization', `Bearer ${token}`)
      .send({ sponsorshipType: 'GENERAL', donorUserId: 'someone-else-entirely' })
      .expect(400);
  });

  it('DTO validation rejects an invalid enum value', async () => {
    const token = await login(donorEmail);
    await request(app.getHttpServer())
      .post('/donor/sponsorships')
      .set('Authorization', `Bearer ${token}`)
      .send({ sponsorshipType: 'NOT_A_REAL_TYPE' })
      .expect(400);
  });
});
