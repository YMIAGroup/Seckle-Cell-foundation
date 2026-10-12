import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { EmailService, MailMessage } from '../src/modules/email/email.service';
import { generateTotpCode } from '../src/common/totp';

/**
 * Covers the auth surface added in this change: signup -> email activation,
 * login lockout, password reset, refresh-token rotation, and TOTP MFA.
 * Runs against a REAL Postgres, same as flow.e2e-spec.ts. EmailService is
 * swapped for an in-memory fake so tests can read the activation/reset
 * links straight out of the "sent" email instead of needing a real inbox.
 */
describe('Auth security (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const run = Date.now();
  const sent: MailMessage[] = [];
  const fakeEmail: Partial<EmailService> = {
    send: async (m: MailMessage) => { sent.push(m); },
    appBaseUrl: () => 'http://localhost:8000',
  };
  const http = () => request(app.getHttpServer());

  const linkToken = (text: string) => new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
  const lastEmailTo = (to: string) => [...sent].reverse().find((m) => m.to === to)!;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(EmailService)
      .useValue(fakeEmail)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  const STRONG_PASSWORD = 'Correct-Horse-9!';

  it('signup -> cannot log in until activated -> activation link works -> can then log in', async () => {
    const email = `auth-signup-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Ada', lastName: 'Donor' }).expect(201);

    const { rows } = await pool.query(`SELECT status FROM users WHERE email=$1`, [email]);
    expect(rows[0].status).toBe('PENDING_ACTIVATION');

    const failed = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(failed.status).toBe(401);
    expect(failed.body.message).toBe('ACCOUNT_NOT_ACTIVATED');

    const token = linkToken(lastEmailTo(email).text);
    const activation = await http().get(`/auth/activate?token=${token}`).expect(200);
    expect(activation.text).toContain('activated');

    const login = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);
    expect(login.body.access_token).toBeDefined();
    expect(login.body.refresh_token).toBeDefined();

    const donorProfile = await pool.query(`SELECT 1 FROM donor_profiles dp JOIN users u ON u.id=dp.user_id WHERE u.email=$1`, [email]);
    expect(donorProfile.rowCount).toBe(1); // activation should have created the donor profile
  });

  it('weak passwords are rejected at signup', async () => {
    const res = await http().post('/auth/signup').send({ email: `auth-weak-${run}@example.test`, password: 'short', firstName: 'A', lastName: 'B' });
    expect(res.status).toBe(400);
  });

  it('signing up twice with a pending email resends activation instead of creating a duplicate user', async () => {
    const email = `auth-resignup-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Ada', lastName: 'Donor' }).expect(201);
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Ada', lastName: 'Donor' }).expect(201);
    const { rowCount } = await pool.query(`SELECT 1 FROM users WHERE email=$1`, [email]);
    expect(rowCount).toBe(1);
  });

  it('account locks after repeated failed logins, even with the correct password on the next attempt', async () => {
    const email = `auth-lockout-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Lock', lastName: 'Out' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);

    for (let i = 0; i < 5; i++) {
      await http().post('/auth/login').send({ email, password: 'WrongPassword123!' }).expect(401);
    }
    const res = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('ACCOUNT_TEMPORARILY_LOCKED');
  });

  it('password reset: old password stops working, new one works, and it revokes existing sessions', async () => {
    const email = `auth-reset-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Reset', lastName: 'Me' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const session = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);

    await http().post('/auth/forgot-password').send({ email }).expect(201);
    const resetToken = linkToken(lastEmailTo(email).text);
    const NEW_PASSWORD = 'New-Horse-Battery-7!';
    await http().post('/auth/reset-password').send({ token: resetToken, newPassword: NEW_PASSWORD }).expect(201);

    await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(401);
    await http().post('/auth/login').send({ email, password: NEW_PASSWORD }).expect(201);

    // The refresh token issued before the reset must no longer work.
    await http().post('/auth/refresh').send({ refreshToken: session.body.refresh_token }).expect(401);
  });

  it('refresh token rotation: using a refresh token twice fails the second time', async () => {
    const email = `auth-refresh-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Ref', lastName: 'Resh' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);

    const first = await http().post('/auth/refresh').send({ refreshToken: login.body.refresh_token }).expect(201);
    expect(first.body.access_token).toBeDefined();
    // Replaying the original (now-rotated) refresh token must be rejected.
    await http().post('/auth/refresh').send({ refreshToken: login.body.refresh_token }).expect(401);
    // The new one from rotation still works.
    await http().post('/auth/refresh').send({ refreshToken: first.body.refresh_token }).expect(201);
  });

  it('MFA: login requires a TOTP code once enabled, and a stale mfa_token cannot be used as a bearer token elsewhere', async () => {
    const email = `auth-mfa-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: STRONG_PASSWORD, firstName: 'Mfa', lastName: 'User' }).expect(201);
    await http().get(`/auth/activate?token=${linkToken(lastEmailTo(email).text)}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);
    const auth = { Authorization: `Bearer ${login.body.access_token}` };

    const setup = await http().post('/auth/mfa/setup').set(auth).expect(201);
    expect(setup.body.secret).toBeDefined();

    await http().post('/auth/mfa/verify-setup').set(auth).send({ code: '000000' }).expect(400);
    const goodCode = generateTotpCode(setup.body.secret);
    await http().post('/auth/mfa/verify-setup').set(auth).send({ code: goodCode }).expect(201);

    const mfaLogin = await http().post('/auth/login').send({ email, password: STRONG_PASSWORD }).expect(201);
    expect(mfaLogin.body.requires_mfa).toBe(true);
    expect(mfaLogin.body.access_token).toBeUndefined();

    // The mfa_token proves "password was correct", nothing more -- it must not work as a normal Bearer token.
    await http().post('/auth/mfa/setup').set({ Authorization: `Bearer ${mfaLogin.body.mfa_token}` }).expect(401);

    const freshSecret = await pool.query(`SELECT mfa_secret FROM users WHERE email=$1`, [email]);
    const code = generateTotpCode(freshSecret.rows[0].mfa_secret);
    const verified = await http().post('/auth/mfa/verify').send({ mfaToken: mfaLogin.body.mfa_token, code }).expect(201);
    expect(verified.body.access_token).toBeDefined();
  });
});
