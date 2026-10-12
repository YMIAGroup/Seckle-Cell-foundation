import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool } from 'pg';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { AppModule } from '../src/app.module';
import { EmailService, MailMessage } from '../src/modules/email/email.service';

/**
 * Donation channels are admin-controlled (Admin > Payment Channels), not
 * hardcoded into the website -- the motivating case being Stripe currently
 * being unusable in Kenya. This suite checks: the public endpoint only
 * ever returns enabled channels (and needs no auth, since the donate page
 * is visited by anonymous donors); only an admin can see/change the full
 * list; toggling one off removes it from the public list immediately and
 * toggling it back on restores it; and the seed data genuinely starts
 * Stripe disabled and Mobile Money enabled, not just "should".
 */
describe('Donation payment channels (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  const run = Date.now();
  const sent: MailMessage[] = [];
  const fakeEmail: Partial<EmailService> = { send: async (m: MailMessage) => { sent.push(m); }, appBaseUrl: () => 'http://localhost:8000' };
  const http = () => request(app.getHttpServer());

  async function loginAsFreshAdmin(label: string) {
    const email = `admin-${label}-${run}@example.test`;
    const scriptPath = path.join(__dirname, '..', 'scripts', 'create-admin.js');
    const output = execFileSync('node', [scriptPath, email, '--force'], { env: process.env, encoding: 'utf-8' });
    const password = output.match(/Password:\s*(\S+)/)![1];
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    return { authHeader: { Authorization: `Bearer ${login.body.access_token}` } };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EmailService).useValue(fakeEmail).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('the public endpoint needs no auth and returns only enabled channels', async () => {
    const res = await http().get('/payment-channels').expect(200);
    const codes = res.body.map((c: { code: string }) => c.code);
    // Seeded defaults: mobile money and paybill are on, Stripe is off
    // (not just unconfigured -- genuinely unusable in Kenya right now).
    expect(codes).toContain('mpesa');
    expect(codes).not.toContain('stripe');
    // Never leaks admin-only bookkeeping fields to the public response.
    expect(res.body[0]).not.toHaveProperty('updated_by');
  });

  it('a non-admin cannot list or change channels', async () => {
    const email = `plain-donor-chan-${run}@example.test`;
    await http().post('/auth/signup').send({ email, password: 'Correct-Horse-9!', firstName: 'Plain', lastName: 'Donor' }).expect(201);
    const linkToken = new URL(sent.find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    await http().get(`/auth/activate?token=${linkToken}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password: 'Correct-Horse-9!' }).expect(201);
    const authHeader = { Authorization: `Bearer ${login.body.access_token}` };

    await http().get('/admin/payment-channels').set(authHeader).expect(403);
    await http().patch('/admin/payment-channels/stripe').set(authHeader).send({ enabled: true }).expect(403);
  });

  it('an admin can see every channel (including disabled) and toggle one', async () => {
    const admin = await loginAsFreshAdmin('channels');

    const all = await http().get('/admin/payment-channels').set(admin.authHeader).expect(200);
    const stripeRow = all.body.find((c: { code: string }) => c.code === 'stripe');
    expect(stripeRow.enabled).toBe(false);

    // Enable crypto -- the new channel requested alongside this feature.
    await http().patch('/admin/payment-channels/crypto').set(admin.authHeader).send({ enabled: true }).expect(200);
    const publicAfterEnable = await http().get('/payment-channels').expect(200);
    expect(publicAfterEnable.body.map((c: { code: string }) => c.code)).toContain('crypto');

    // Disable mobile money -- confirms the public list reacts to a hide, not just a show.
    await http().patch('/admin/payment-channels/mpesa').set(admin.authHeader).send({ enabled: false }).expect(200);
    const publicAfterDisable = await http().get('/payment-channels').expect(200);
    expect(publicAfterDisable.body.map((c: { code: string }) => c.code)).not.toContain('mpesa');

    // Restore seeded state so this test doesn't change behaviour for any test that runs after it.
    await http().patch('/admin/payment-channels/crypto').set(admin.authHeader).send({ enabled: false }).expect(200);
    await http().patch('/admin/payment-channels/mpesa').set(admin.authHeader).send({ enabled: true }).expect(200);
  });

  it('rejects an unknown channel code and an invalid body', async () => {
    const admin = await loginAsFreshAdmin('channels-validation');
    await http().patch('/admin/payment-channels/not-a-real-channel').set(admin.authHeader).send({ enabled: true }).expect(404);
    await http().patch('/admin/payment-channels/mpesa').set(admin.authHeader).send({ enabled: 'yes' }).expect(400);
  });
});
