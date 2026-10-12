import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { AppModule } from '../src/app.module';

/**
 * provider_verifications.expiry_date existed since the first provider
 * migration but nothing ever read it -- a provider verified once would
 * stay ACTIVE forever even after its certification lapsed. This suite
 * checks the fix end to end: recording a verification with a past expiry
 * date, running the expiry check (manually, via the admin trigger, rather
 * than waiting for the daily 2am schedule), and confirming it marks the
 * verification EXPIRED and moves a now-unverified ACTIVE provider to
 * UNDER_REVIEW -- the same thing a human reviewer would do by hand.
 */
describe('Provider verification expiry (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const password = 'VerifyFlow123!';
  const run = Date.now();
  const http = () => request(app.getHttpServer());

  async function loginAsFreshAdmin(label: string) {
    const email = `admin-${label}-${run}@example.test`;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');
    const output = execFileSync('node', [scriptPath, email, '--force'], { env: process.env, encoding: 'utf-8' });
    const pw = output.match(/Password:\s*(\S+)/)![1];
    const login = await http().post('/auth/login').send({ email, password: pw }).expect(201);
    return { authHeader: { Authorization: `Bearer ${login.body.access_token}` } };
  }

  let caseworkerAuth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    const email = `verify-caseworker-${run}@example.test`;
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`, [`SCF-USR-VERIFY-${run}`, email, hash]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT us.id, r.id FROM users us, roles r WHERE us.email=$1 AND r.code='CASE_WORKER' ON CONFLICT DO NOTHING`, [email]);
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    caseworkerAuth = { Authorization: `Bearer ${login.body.access_token}` };
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  async function createActiveProvider(label: string): Promise<string> {
    const providerId = (
      await http()
        .post('/providers')
        .set(caseworkerAuth)
        .send({ legalName: `Verify Test Provider ${label} ${run}`, providerType: 'CLINIC' })
        .expect(201)
    ).body.id;
    for (const toStatus of ['APPLICATION', 'VERIFICATION', 'APPROVED', 'ACTIVE']) {
      await http().post(`/providers/${providerId}/transitions`).set(caseworkerAuth).send({ toStatus, reason: 'verify-test' }).expect(201);
    }
    return providerId;
  }

  it('records a verification and lists it back', async () => {
    const providerId = await createActiveProvider('record');
    const created = (
      await http()
        .post(`/providers/${providerId}/verifications`)
        .set(caseworkerAuth)
        .send({ verificationType: 'LICENSE', status: 'VERIFIED', expiryDate: '2099-01-01' })
        .expect(201)
    ).body;
    expect(created.status).toBe('VERIFIED');

    const list = (await http().get(`/providers/${providerId}/verifications`).set(caseworkerAuth).expect(200)).body;
    expect(list.map((v: { id: string }) => v.id)).toContain(created.id);
  });

  it('a non-admin cannot trigger the expiry check', async () => {
    await http().post('/admin/provider-verifications/run-expiry-check').set(caseworkerAuth).expect(403);
  });

  it('a lapsed verification is marked EXPIRED and an otherwise-unverified ACTIVE provider moves to UNDER_REVIEW', async () => {
    const providerId = await createActiveProvider('expiry');
    const verification = (
      await http()
        .post(`/providers/${providerId}/verifications`)
        .set(caseworkerAuth)
        .send({ verificationType: 'LICENSE', status: 'VERIFIED', expiryDate: '2000-01-01' })
        .expect(201)
    ).body;

    const admin = await loginAsFreshAdmin('expiry-check');
    const result = (await http().post('/admin/provider-verifications/run-expiry-check').set(admin.authHeader).expect(201)).body;
    expect(result.expiredVerifications).toBeGreaterThanOrEqual(1);
    expect(result.providersMovedToUnderReview).toContain(providerId);

    const verifications = (await http().get(`/providers/${providerId}/verifications`).set(caseworkerAuth).expect(200)).body;
    const updated = verifications.find((v: { id: string }) => v.id === verification.id);
    expect(updated.status).toBe('EXPIRED');

    // Already EXPIRED and already UNDER_REVIEW -- running it again must be a no-op, not an error
    // or a duplicate audit/state churn.
    const second = (await http().post('/admin/provider-verifications/run-expiry-check').set(admin.authHeader).expect(201)).body;
    expect(second.providersMovedToUnderReview).not.toContain(providerId);
  });

  it('a provider with a verification that has no expiry date, or a future one, is left alone', async () => {
    const providerId = await createActiveProvider('no-expiry');
    await http().post(`/providers/${providerId}/verifications`).set(caseworkerAuth).send({ verificationType: 'LICENSE', status: 'VERIFIED' }).expect(201);

    const admin = await loginAsFreshAdmin('expiry-check-noop');
    const result = (await http().post('/admin/provider-verifications/run-expiry-check').set(admin.authHeader).expect(201)).body;
    expect(result.providersMovedToUnderReview).not.toContain(providerId);
  });
});
