import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';
import { EmailService, MailMessage } from '../src/modules/email/email.service';

/**
 * Notifications are in-app only, strictly scoped to the caller's own
 * user_id — there is no route or parameter that reaches another user's
 * notification. This suite checks that end to end against a real
 * trigger (a donation being confirmed notifies the donor who made it),
 * not just against NotificationsService in isolation, plus the
 * cross-user isolation on read and on the two write routes.
 */
describe('Notifications (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const run = Date.now();
  const sent: MailMessage[] = [];
  const fakeEmail: Partial<EmailService> = { send: async (m: MailMessage) => { sent.push(m); }, appBaseUrl: () => 'http://localhost:8000' };
  const http = () => request(app.getHttpServer());

  async function signupAndActivateDonor(label: string) {
    const email = `notif-${label}-${run}@example.test`;
    const password = 'NotifFlow123!';
    await http().post('/auth/signup').send({ email, password, firstName: 'Notif', lastName: label }).expect(201);
    const token = new URL(sent.find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    await http().get(`/auth/activate?token=${token}`).expect(200);
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    return { Authorization: `Bearer ${login.body.access_token}` };
  }

  async function bootstrapFinanceOfficer() {
    const email = `notif-finance-${run}@example.test`;
    const password = 'NotifFlow123!';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`, [`SCF-USR-NOTIF-FIN-${run}`, email, hash]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT us.id, r.id FROM users us, roles r WHERE us.email=$1 AND r.code='FINANCE_OFFICER' ON CONFLICT DO NOTHING`, [email]);
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    return { Authorization: `Bearer ${login.body.access_token}` };
  }

  let donorA: { Authorization: string };
  let donorB: { Authorization: string };
  let financeAuth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(EmailService).useValue(fakeEmail).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    donorA = await signupAndActivateDonor('a');
    donorB = await signupAndActivateDonor('b');
    financeAuth = await bootstrapFinanceOfficer();
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  it('starts with no notifications and an unread count of 0', async () => {
    const list = (await http().get('/notifications').set(donorA).expect(200)).body;
    expect(list).toEqual([]);
    expect((await http().get('/notifications/unread-count').set(donorA).expect(200)).body.count).toBe(0);
  });

  it('a confirmed donation notifies the donor who made it, and nobody else', async () => {
    const fundId = (await http().post('/funds').set(financeAuth).send({ name: `Notif Fund ${run}`, fundType: 'GENERAL' }).expect(201)).body.id;
    const donationId = (await http().post('/donor/donations').set(donorA).send({ fundId, amount: 1500 }).expect(201)).body.id;
    await http().post(`/finance/donations/${donationId}/confirm`).set(financeAuth).send({ externalReference: `NOTIF-EXT-${run}` }).expect(201);

    const listA = (await http().get('/notifications').set(donorA).expect(200)).body;
    expect(listA.length).toBe(1);
    expect(listA[0].type).toBe('DONATION_RECEIVED');
    expect(listA[0].read_at).toBeNull();
    expect((await http().get('/notifications/unread-count').set(donorA).expect(200)).body.count).toBe(1);

    // Donor B's donation was never touched -- must see nothing.
    const listB = (await http().get('/notifications').set(donorB).expect(200)).body;
    expect(listB).toEqual([]);
  });

  it('a donor cannot mark another donor\'s notification as read', async () => {
    const listA = (await http().get('/notifications').set(donorA).expect(200)).body;
    const notificationId = listA[0].id;
    await http().post(`/notifications/${notificationId}/read`).set(donorB).expect(404);
    // Unaffected by donor B's attempt -- still unread for donor A.
    expect((await http().get('/notifications/unread-count').set(donorA).expect(200)).body.count).toBe(1);
  });

  it('a donor can mark their own notification read, and read-all clears the rest', async () => {
    const listA = (await http().get('/notifications').set(donorA).expect(200)).body;
    const notificationId = listA[0].id;
    await http().post(`/notifications/${notificationId}/read`).set(donorA).expect(201);
    expect((await http().get('/notifications/unread-count').set(donorA).expect(200)).body.count).toBe(0);

    // Generate a second notification, then clear everything with read-all.
    const fundId = (await http().post('/funds').set(financeAuth).send({ name: `Notif Fund 2 ${run}`, fundType: 'GENERAL' }).expect(201)).body.id;
    const donationId = (await http().post('/donor/donations').set(donorA).send({ fundId, amount: 750 }).expect(201)).body.id;
    await http().post(`/finance/donations/${donationId}/confirm`).set(financeAuth).send({ externalReference: `NOTIF-EXT-2-${run}` }).expect(201);
    expect((await http().get('/notifications/unread-count').set(donorA).expect(200)).body.count).toBe(1);

    await http().post('/notifications/read-all').set(donorA).expect(201);
    expect((await http().get('/notifications/unread-count').set(donorA).expect(200)).body.count).toBe(0);

    const unreadOnly = (await http().get('/notifications?unreadOnly=true').set(donorA).expect(200)).body;
    expect(unreadOnly).toEqual([]);
  });

  it('requires authentication', async () => {
    await http().get('/notifications').expect(401);
  });
});
