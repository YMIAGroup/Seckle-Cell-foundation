import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';

/**
 * Reporting is a read-only aggregation layer (ReportingModule) gated on
 * a REPORTING data-domain grant, not on any of the existing CARE/
 * FINANCE/DONOR grants -- the whole point being that a MEL/audit role
 * can see cross-domain numbers without being handed WRITE (or even READ)
 * on the domains those numbers are drawn from. This suite checks: a role
 * with the grant (MEL_OFFICER) can reach every route and gets sane
 * shapes back; a role without it (CASE_WORKER, which has CARE:WRITE but
 * nothing in REPORTING) is denied; and the numbers genuinely reflect
 * real rows this test creates, not just "the route returns 200".
 */
describe('Reporting (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const password = 'ReportFlow123!';
  const run = Date.now();
  const http = () => request(app.getHttpServer());

  async function bootstrapUser(label: string, roleCode: string) {
    const email = `report-${label}-${run}@example.test`;
    const hash = await bcrypt.hash(password, 10);
    await pool.query(`INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`, [`SCF-USR-RPT-${label}-${run}`, email, hash]);
    await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT us.id, r.id FROM users us, roles r WHERE us.email=$1 AND r.code=$2 ON CONFLICT DO NOTHING`, [email, roleCode]);
    const login = await http().post('/auth/login').send({ email, password }).expect(201);
    return { Authorization: `Bearer ${login.body.access_token}` };
  }

  let melAuth: { Authorization: string };
  let caseworkerAuth: { Authorization: string };
  let financeAuth: { Authorization: string };
  let donorAuth: { Authorization: string };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });

    melAuth = await bootstrapUser('mel', 'MEL_OFFICER');
    caseworkerAuth = await bootstrapUser('cw', 'CASE_WORKER');
    financeAuth = await bootstrapUser('fin', 'FINANCE_OFFICER');
    donorAuth = await bootstrapUser('donor', 'DONOR');
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  const routes = [
    '/reporting/overview',
    '/reporting/cases-by-status',
    '/reporting/needs-by-category',
    '/reporting/interventions-by-status',
    '/reporting/fund-balances',
    '/reporting/donations-over-time',
    '/reporting/sponsorships-summary',
    '/reporting/providers-by-status',
    '/reporting/provider-verifications-expiring-soon',
    '/reporting/service-delivery-summary',
  ];

  it('a role with the REPORTING grant (MEL_OFFICER) can reach every reporting route', async () => {
    for (const route of routes) {
      const res = await http().get(route).set(melAuth).expect(200);
      expect(res.body).toBeDefined();
    }
  });

  it('a role without the REPORTING grant (CASE_WORKER, despite having CARE:WRITE) is denied on every route', async () => {
    for (const route of routes) {
      await http().get(route).set(caseworkerAuth).expect(403);
    }
  });

  it('FINANCE_OFFICER also has the REPORTING grant and can read fund balances', async () => {
    await http().get('/reporting/fund-balances').set(financeAuth).expect(200);
  });

  it('no auth at all is rejected, not just forbidden', async () => {
    await http().get('/reporting/overview').expect(401);
  });

  it('the overview reflects a real fund balance and a real confirmed donation, not a stub', async () => {
    const fundId = (await http().post('/funds').set(financeAuth).send({ name: `Reporting Fund ${run}`, fundType: 'GENERAL' }).expect(201)).body.id;
    const donationId = (await http().post('/donor/donations').set(donorAuth).send({ fundId, amount: 2500 }).expect(201)).body.id;
    await http().post(`/finance/donations/${donationId}/confirm`).set(financeAuth).send({ externalReference: `RPT-EXT-${run}` }).expect(201);

    const overview = (await http().get('/reporting/overview').set(melAuth).expect(200)).body;
    expect(overview.donationsReceived.total).toBeGreaterThanOrEqual(2500);
    expect(overview.totalFundBalance).toBeGreaterThanOrEqual(2500);

    const balances = (await http().get('/reporting/fund-balances').set(melAuth).expect(200)).body;
    const thisFund = balances.find((f: { id: string }) => f.id === fundId);
    expect(thisFund.balance).toBe(2500);

    const overTime = (await http().get('/reporting/donations-over-time').set(melAuth).expect(200)).body;
    const totalAcrossBuckets = overTime.reduce((sum: number, b: { total: number }) => sum + b.total, 0);
    expect(totalAcrossBuckets).toBeGreaterThanOrEqual(2500);
  });

  it('rejects an invalid interval query param', async () => {
    await http().get('/reporting/donations-over-time?interval=fortnight').set(melAuth).expect(400);
  });
});
