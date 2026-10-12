import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcrypt';
import { Pool } from 'pg';
import { AppModule } from '../src/app.module';

/**
 * Business-flow e2e against a REAL Postgres. Unlike the unit tests
 * (mocked DB) these exercise the actual SQL, the real ledger math, and
 * the real guards together — the class of bug mocks cannot catch.
 */
describe('SCCF business flows (e2e, real database)', () => {
  let app: INestApplication;
  let pool: Pool;
  const password = 'FlowTest123!';
  const run = Date.now();
  const users: Record<string, { email: string; role: string; token?: string; id?: string }> = {
    finance: { email: 'flow-finance@example.test', role: 'FINANCE_OFFICER' },
    caseworker: { email: 'flow-caseworker@example.test', role: 'CASE_WORKER' },
    donor: { email: 'flow-donor@example.test', role: 'DONOR' },
    donor2: { email: 'flow-donor2@example.test', role: 'DONOR' },
    clinician: { email: 'flow-clinician@example.test', role: 'CLINICAL_REVIEWER' },
    guardian: { email: 'flow-safeguarding@example.test', role: 'SAFEGUARDING_OFFICER' },
  };
  const http = () => request(app.getHttpServer());
  const as = (u: string) => ({ Authorization: `Bearer ${users[u].token}` });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const hash = await bcrypt.hash(password, 10);
    for (const [key, u] of Object.entries(users)) {
      await pool.query(`INSERT INTO users (user_ref, email, password_hash, status) VALUES ($1,$2,$3,'ACTIVE') ON CONFLICT (email) DO NOTHING`, [`SCF-USR-FLOW-${key}`, u.email, hash]);
      await pool.query(`INSERT INTO user_roles (user_id, role_id) SELECT us.id, r.id FROM users us, roles r WHERE us.email=$1 AND r.code=$2 ON CONFLICT DO NOTHING`, [u.email, u.role]);
      const res = await http().post('/auth/login').send({ email: u.email, password }).expect(201);
      u.token = res.body.access_token;
      u.id = (await pool.query('SELECT id FROM users WHERE email=$1', [u.email])).rows[0].id;
    }
  });
  afterAll(async () => { await app.close(); await pool.end(); });

  let fundId: string, donationId: string, beneficiaryId: string, caseId: string, needId: string, interventionId: string, sponsorshipId: string;

  it('donation flow: donor pledges, finance confirms, fund balance reflects it exactly once', async () => {
    fundId = (await http().post('/funds').set(as('finance')).send({ name: `Flow Fund ${run}`, fundType: 'GENERAL' }).expect(201)).body.id;
    donationId = (await http().post('/donor/donations').set(as('donor')).send({ fundId, amount: 10000 }).expect(201)).body.id;

    await http().post(`/finance/donations/${donationId}/confirm`).set(as('finance')).send({ externalReference: `EXT-${run}` }).expect(201);
    expect((await http().get(`/funds/${fundId}/balance`).set(as('finance')).expect(200)).body.balance).toBe(10000);

    // Idempotent replay (e.g. a duplicate payment-provider webhook): must NOT double-post.
    await http().post(`/finance/donations/${donationId}/confirm`).set(as('finance')).send({ externalReference: `EXT-${run}` }).expect(201);
    expect((await http().get(`/funds/${fundId}/balance`).set(as('finance')).expect(200)).body.balance).toBe(10000);
  });

  it('care flow: beneficiary -> case -> need -> intervention through the real state machines', async () => {
    beneficiaryId = (await http().post('/beneficiaries').set(as('caseworker')).send({ firstName: 'Flowchild', lastName: 'Private', dateOfBirth: '2017-03-01', county: 'Nairobi', schoolName: 'Secret Primary' }).expect(201)).body.id;
    caseId = (await http().post(`/beneficiaries/${beneficiaryId}/cases`).set(as('caseworker')).expect(201)).body.id;
    for (const toStatus of ['SUBMITTED', 'UNDER_ASSESSMENT', 'ACTIVE']) {
      await http().post(`/cases/${caseId}/transitions`).set(as('caseworker')).send({ toStatus, reason: 'flow' }).expect(201);
    }
    // An invalid jump must be rejected by the state machine.
    await http().post(`/cases/${caseId}/transitions`).set(as('caseworker')).send({ toStatus: 'DRAFT', reason: 'illegal' }).expect(400);
    needId = (await http().post('/needs').set(as('caseworker')).send({ caseId, category: 'MEDICATION', title: 'Monthly meds', priority: 'HIGH' }).expect(201)).body.id;
    interventionId = (await http().post('/interventions').set(as('caseworker')).send({ needId, interventionType: 'MEDICATION_PURCHASE' }).expect(201)).body.id;
  });

  it('allocation flow: allocates from the fund, and rejects over-allocation', async () => {
    await http().post('/allocations').set(as('finance')).send({ fundId, amount: 4000, beneficiaryId, interventionId }).expect(201);
    expect((await http().get(`/funds/${fundId}/balance`).set(as('finance')).expect(200)).body.balance).toBe(6000);
    await http().post('/allocations').set(as('finance')).send({ fundId, amount: 9000, beneficiaryId, interventionId }).expect(400);
  });

  it('donor-safe view: an ACTIVE named-child sponsorship returns ONLY the privacy-safe projection', async () => {
    sponsorshipId = (await http().post('/donor/sponsorships').set(as('donor')).send({ sponsorshipType: 'NAMED_CHILD', beneficiaryId, monthlyAmount: 3000 }).expect(201)).body.id;
    // Not yet approved by staff -> the donor can't see anything.
    await http().get(`/donor/sponsorships/${sponsorshipId}/child-profile`).set(as('donor')).expect(403);
    // A donor cannot activate their own sponsorship.
    await http().post(`/sponsorships/${sponsorshipId}/transitions`).set(as('donor')).send({ toStatus: 'ACTIVE' }).expect(403);
    // Staff activates it.
    await http().post(`/sponsorships/${sponsorshipId}/transitions`).set(as('caseworker')).send({ toStatus: 'ACTIVE' }).expect(201);

    const res = await http().get(`/donor/sponsorships/${sponsorshipId}/child-profile`).set(as('donor')).expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['ageGroup', 'beneficiaryRef', 'county', 'latestSupportSummary', 'programmeSummary', 'status'].sort());
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('Flowchild');
    expect(raw).not.toContain('Private');
    expect(raw).not.toContain('Secret Primary');
    expect(raw).not.toContain('2017-03-01'); // exact DOB must be bucketed into an age band
    expect(res.body.county).toBe('Nairobi');
  });

  it("donor isolation: another donor cannot view someone else's sponsored child", async () => {
    await http().get(`/donor/sponsorships/${sponsorshipId}/child-profile`).set(as('donor2')).expect(403);
  });

  it('clinical/safeguarding isolation: officer sees THAT a clinical event is linked, never WHAT it is', async () => {
    const profileId = (await http().post(`/clinical/beneficiaries/${beneficiaryId}/profile`).set(as('clinician')).expect(201)).body.id;
    const incidentId = (await http().post('/safeguarding/incidents').set(as('guardian')).send({ category: 'SG-02', severity: 'LEVEL_2', description: 'flow test', beneficiaryId }).expect(201)).body.id;
    await http().post(`/clinical/profiles/${profileId}/events`).set(as('clinician')).send({ eventType: 'HOSPITALIZATION', eventDate: '2026-08-01T10:00:00Z', description: 'CONFIDENTIAL CLINICAL DETAIL', linkedSafeguardingIncidentId: incidentId }).expect(201);

    const res = await http().get(`/safeguarding/incidents/${incidentId}/linked-clinical-events`).set(as('guardian')).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].hasLinkedSafeguardingIncident).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('HOSPITALIZATION');
    expect(JSON.stringify(res.body)).not.toContain('CONFIDENTIAL');
    // The safeguarding officer has no path to the full clinical record.
    await http().get(`/clinical/beneficiaries/${beneficiaryId}/profile`).set(as('guardian')).expect(403);
  });

  it('any authenticated user can report a safeguarding concern, incl. an unregistered child, but cannot act on it', async () => {
    const r = await http().post('/safeguarding/incidents').set(as('donor')).send({ category: 'SG-01', severity: 'LEVEL_1', description: 'worried about a child', reportedSubjectName: 'Unknown child' }).expect(201);
    expect(r.body.is_unregistered_child).toBe(true);
    await http().post(`/safeguarding/incidents/${r.body.id}/transitions`).set(as('donor')).send({ toStatus: 'SCREENING' }).expect(403);
  });

  it('audit trail: the actions above were recorded', async () => {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action IN ('DONATION_RECEIVED','ALLOCATION_CREATED','SPONSORSHIP_STATUS_TRANSITION','CASE_STATUS_TRANSITION')`);
    expect(rows[0].n).toBeGreaterThanOrEqual(4);
    const access = await pool.query(`SELECT count(*)::int AS n FROM data_access_logs WHERE data_domain='DONOR'`);
    expect(access.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
