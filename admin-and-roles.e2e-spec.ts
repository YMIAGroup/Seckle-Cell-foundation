import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { EmailService, MailMessage } from '../src/modules/email/email.service';

/**
 * Covers everything added on top of donor auth: admin invite -> accept,
 * caregiver signup, provider signup -> admin link, account unlock, and
 * that MFA secrets are genuinely encrypted at rest (not just "should be").
 */
describe('Admin actions, caregiver/provider signup, encryption at rest (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  const run = Date.now();
  const sent: MailMessage[] = [];
  const fakeEmail: Partial<EmailService> = { send: async (m: MailMessage) => { sent.push(m); }, appBaseUrl: () => 'http://localhost:8000' };
  const http = () => request(app.getHttpServer());
  const linkToken = (text: string) => new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const lastEmailTo = (to: string) => [...sent].reverse().find((m) => m.to === to)!;
  const STRONG_PASSWORD = 'Correct-Horse-9!';

  async function loginAsFreshAdmin(label: string) {
    const email = `admin-${label}-${run}@example.test`;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');
    const output = execFileSync('node', [scriptPath, email, '--force'], { env: process.env, encoding: 'utf-8' });
    const password = output.match(/Password:\s*(\S+)/)![1];
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    return { email, authHeader: { Authorization: `Bearer ${login.body.access_token}` } };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EmailService).useValue(fakeEmail).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('a non-admin donor cannot reach any /admin route', async () => {
    const email = `plain-donor-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Plain', lastName: 'Donor' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);
    await http().get('/admin/attention-needed').set({ Authorization: `Bearer ${login.body.access_token}` }).expect(403);
  });

  it('caregiver signup activates without creating a donor_profile', async () => {
    const email = `caregiver-${run}@example.test`;
    await http().post('/auth/signup/caregiver').send({ email, password: STRONG_PASSWORD, firstName: 'Care', lastName: 'Giver' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const { rows: userRows } = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
    const { rowCount } = await pool.query(`SELECT 1 FROM donor_profiles WHERE user_id=$1`, [userRows[0].id]);
    expect(rowCount).toBe(0);
    const roles = await pool.query(`SELECT r.code FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1`, [userRows[0].id]);
    expect(roles.rows.map((r: { code: string }) => r.code)).toEqual(['CAREGIVER']);
  });

  it('admin invite -> accept-invite sets the password and activates in one step, with the invited role', async () => {
    const admin = await loginAsFreshAdmin('inviter');
    const inviteeEmail = `invitee-${run}@example.test`;
    await http().post('/admin/invite').set(admin.authHeader).send({ email: inviteeEmail, firstName: 'Case', lastName: 'Worker', roleCode: 'CASE_WORKER' }).expect(201);

    const { rows: before } = await pool.query(`SELECT status, password_hash FROM users WHERE email=$1`, [inviteeEmail]);
    expect(before[0].status).toBe('PENDING_ACTIVATION');
    expect(before[0].password_hash).toBeNull();

    await http().post('/auth/login').send({ email: inviteeEmail, password: 'whatever-they-guess-12345!' }).expect(401);

    const inviteToken = linkToken(lastEmailTo(inviteeEmail).text);
    await http().post('/auth/invite/accept').send({ token: inviteToken, newPassword: STRONG_PASSWORD }).expect(201);

    const login = await http().post('/auth/login').send({ email: inviteeEmail, password: STRONG_PASSWORD }).expect(201);
    expect(login.body.access_token).toBeDefined();
    const roles = await pool.query(`SELECT r.code FROM user_roles ur JOIN users u ON u.id=ur.user_id JOIN roles r ON r.id=ur.role_id WHERE u.email=$1`, [inviteeEmail]);
    expect(roles.rows.map((r: { code: string }) => r.code)).toEqual(['CASE_WORKER']);
  });

  it('inviting an email that already exists is rejected', async () => {
    const admin = await loginAsFreshAdmin('inviter2');
    const existing = `dup-invite-${run}@example.test`;
    await http().post('/auth/signup').send({ email: existing, password: STRONG_PASSWORD, firstName: 'A', lastName: 'B' }).expect(201);
    await http().post('/admin/invite').set(admin.authHeader).send({ email: existing, firstName: 'X', lastName: 'Y', roleCode: 'CASE_WORKER' }).expect(400);
  });

  it('admin can unlock a locked account early', async () => {
    const admin = await loginAsFreshAdmin('unlocker');
    const email = `to-unlock-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Lock', lastName: 'Me' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    for (let i = 0; i < 5; i++) await http().post('/auth/login').send({ email, password: 'wrong-password-123!' }).expect(401);
    await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(401); // still locked

    const { rows } = await pool.query(`SELECT id FROM users WHERE email=$1`, [email]);
    await http().post(`/admin/users/${rows[0].id}/unlock`).set(admin.authHeader).expect(201);
    await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201); // works again immediately, no reset needed
  });

  it('provider signup is pending-link until an admin links it to a verified provider', async () => {
    const admin = await loginAsFreshAdmin('provider-linker');
    const email = `provider-${run}@example.test`;
    await http().post('/auth/signup/provider').send({
      email, password: STRONG_PASSWORD, firstName: 'Prov', lastName: 'User', organizationName: `Test Clinic ${run}`,
    }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);

    const pending = await http().get('/admin/attention-needed').set(admin.authHeader).expect(200);
    const match = pending.body.pendingProviderLinks.find((p: { email: string }) => p.email === email);
    expect(match).toBeDefined();
    expect(match.claimed_organization_name).toBe(`Test Clinic ${run}`);

    const providers = await http().get('/admin/providers').set(admin.authHeader).expect(200);
    if (providers.body.length > 0) {
      await http().post(`/admin/provider-users/${match.id}/link`).set(admin.authHeader).send({ providerId: providers.body[0].id }).expect(201);
      const after = await pool.query(`SELECT status FROM provider_users WHERE user_id=(SELECT id FROM users WHERE email=$1)`, [email]);
      expect(after.rows[0].status).toBe('LINKED');
    }
  });

  it('MFA secret is stored encrypted, not as a plain base32 string', async () => {
    const email = `mfa-encrypted-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Mfa', lastName: 'Enc' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.access_token}` };
    const setup = await http().post('/auth/mfa/setup').set(auth).expect(201);

    const { rows } = await pool.query(`SELECT mfa_secret_pending FROM users WHERE email=$1`, [email]);
    const stored = rows[0].mfa_secret_pending as string;
    expect(stored).not.toBe(setup.body.secret); // not the plaintext secret
    expect(stored).toMatch(/^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/); // iv.authTag.ciphertext, all hex
  });
});
