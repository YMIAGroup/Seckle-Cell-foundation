import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';

/**
 * Duplicate-sponsorship guard (sponsorship.service.ts assertNoDuplicate()
 * + the partial unique indexes in migration 014). Nothing previously
 * stopped the same donor ending up with two live NAMED_CHILD sponsorships
 * for the same beneficiary. This checks the application-level 400 (the
 * common case) end to end against real Postgres, and that it's really
 * "no other LIVE one", not "never again" -- ending a sponsorship frees
 * the donor to sponsor that same child again later.
 */
describe('Duplicate-sponsorship guard (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const password = 'DupSponsorFlow123!';
  const run = Date.now();
  const http = () => request(app.getHttpServer());
  let donorAuth: { Authorization: string };
  let caseworkerAuth: { Authorization: string };
  let beneficiaryId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const hash = await bcrypt.hash(password, 10);

    for (const [key, role] of [['donor', 'DONOR'], ['cw', 'CASE_WORKER']] as const) {
      const email = `dupspon-${key}-${run}@example.test`;
      await pool.query(`INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`, [`SCF-USR-DUPSPON-${key}-${run}`, email, hash]);
      await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT us.id, r.id FROM users us, roles r WHERE us.email=$1 AND r.code=$2 ON CONFLICT DO NOTHING`, [email, role]);
      const login = await http().post('/auth/login').send({ email, password }).expect(201);
      const auth = { Authorization: `Bearer ${login.body.access_token}` };
      if (key === 'donor') donorAuth = auth; else caseworkerAuth = auth;
    }

    beneficiaryId = (
      await http().post('/beneficiaries').set(caseworkerAuth).send({ firstName: 'Dup', lastName: 'Sponsor', dateOfBirth: '2015-01-01', county: 'Nairobi' }).expect(201)
    ).body.id;
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  let firstSponsorshipId: string;

  it('a first NAMED_CHILD sponsorship for a beneficiary succeeds', async () => {
    firstSponsorshipId = (
      await http().post('/donor/sponsorships').set(donorAuth).send({ sponsorshipType: 'NAMED_CHILD', beneficiaryId, monthlyAmount: 2000 }).expect(201)
    ).body.id;
  });

  it('a second live NAMED_CHILD sponsorship for the same donor+beneficiary is rejected with DUPLICATE_SPONSORSHIP', async () => {
    const res = await http().post('/donor/sponsorships').set(donorAuth).send({ sponsorshipType: 'NAMED_CHILD', beneficiaryId, monthlyAmount: 1500 }).expect(400);
    expect(res.body.code ?? res.body.message?.code).toBe('DUPLICATE_SPONSORSHIP');
  });

  it('ending the first sponsorship frees the donor to sponsor the same child again', async () => {
    await http().post(`/sponsorships/${firstSponsorshipId}/transitions`).set(caseworkerAuth).send({ toStatus: 'ACTIVE' }).expect(201);
    await http().post(`/sponsorships/${firstSponsorshipId}/transitions`).set(caseworkerAuth).send({ toStatus: 'ENDED' }).expect(201);

    const second = await http().post('/donor/sponsorships').set(donorAuth).send({ sponsorshipType: 'NAMED_CHILD', beneficiaryId, monthlyAmount: 1500 }).expect(201);
    expect(second.body.status).toBe('PROPOSED');
  });
});
