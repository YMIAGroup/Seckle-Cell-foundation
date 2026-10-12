import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { EmailService, MailMessage } from '../src/modules/email/email.service';

/**
 * Runs scripts/create-admin.js for real (as a child process, same as a
 * developer would from PowerShell) against the same test database the
 * rest of the e2e suite uses, then exercises the account it creates
 * through the real HTTP API. This is the one test in the suite that
 * isn't just calling a controller -- it's checking the actual bootstrap
 * story end to end: script creates account -> account can log in ->
 * must_change_password is true -> resetting the password clears it.
 */
describe('Admin bootstrap script (e2e, real database + real subprocess)', () => {
  let app: INestApplication;
  let pool: Pool;
  const http = () => request(app.getHttpServer());
  const sent: MailMessage[] = [];
  const fakeEmail: Partial<EmailService> = {
    send: async (m: MailMessage) => { sent.push(m); },
    appBaseUrl: () => 'http://localhost:8000',
  };
  const linkToken = (text: string) => new URL(text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;

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

  it('creates a working SYSTEM_ADMIN account with a one-time password that must be changed', async () => {
    const email = `bootstrap-admin-${Date.now()}@example.test`;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');

    const output = execFileSync('node', [scriptPath, email, '--force'], {
      env: process.env, encoding: 'utf-8',
    });
    expect(output).toContain('SYSTEM_ADMIN account created');

    const match = output.match(/Password:\s*(\S+)/);
    expect(match).not.toBeNull();
    const password = match![1];

    const roleCheck = await pool.query(
      `SELECT r.code FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.email=$1`,
      [email],
    );
    expect(roleCheck.rows.map((r: { code: string }) => r.code)).toContain('SYSTEM_ADMIN');

    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    expect(login.body.access_token).toBeDefined();
    expect(login.body.must_change_password).toBe(true);

    // Follow the real recommended path from the script's own printed instructions:
    // forgot-password -> reset-password with the emailed token -> must_change_password clears.
    await http().post('/auth/forgot-password').send({ email }).expect(201);
    const resetToken = linkToken(sent[sent.length - 1].text);
    const newPassword = 'Chosen-By-The-Admin-7!';
    await http().post('/auth/reset-password').send({ token: resetToken, newPassword }).expect(201);

    await http().post('/auth/login').send({ email, password }).expect(401); // old one-time password no longer works
    const reLogin = await http().post('/auth/login').send({ email, password: newPassword }).expect(201);
    expect(reLogin.body.must_change_password).toBe(false);
  });

  it('refuses to create a second admin without --force once one already exists', () => {
    const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');
    const output = execFileSync('node', [scriptPath, `should-not-be-created-${Date.now()}@example.test`], {
      env: process.env, encoding: 'utf-8',
    });
    expect(output).toContain('already exists');
  });
});
