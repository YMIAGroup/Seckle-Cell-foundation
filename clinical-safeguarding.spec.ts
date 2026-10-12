import { ClinicalEventService } from '../src/modules/clinical/clinical-event.service';
import { SafeguardingService } from '../src/modules/safeguarding/safeguarding.service';

const fakeAudit = { record: jest.fn(), recordDataAccess: jest.fn() } as any;
const allow = { hasAtLeast: jest.fn().mockResolvedValue(true) } as any;
beforeEach(() => jest.clearAllMocks());

describe('ClinicalEventService — existence-only visibility', () => {
  it('forSafeguardingContext returns existence-only records, never event details', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ id: 'clinical-event-1' }] }) } as any;
    const result = await new ClinicalEventService(db, fakeAudit, allow).forSafeguardingContext('inc-1', 'officer');
    expect(result).toHaveLength(1);
    expect(result[0].hasLinkedSafeguardingIncident).toBe(true);
    expect(result[0].id).toBe('');
    expect(result[0].eventType).toBe('');
    expect(result[0].eventDate).toBe('');
  });

  it('forSafeguardingContext still requires SAFEGUARDING:READ', async () => {
    const deny = { hasAtLeast: jest.fn().mockResolvedValue(false) } as any;
    await expect(new ClinicalEventService({ query: jest.fn() } as any, fakeAudit, deny).forSafeguardingContext('inc', 'x')).rejects.toThrow();
  });

  it('getFullEvent requires CLINICAL:READ independently — SAFEGUARDING access is not enough', async () => {
    const safeguardingOnly = { hasAtLeast: jest.fn().mockImplementation((_u: string, d: string) => Promise.resolve(d !== 'CLINICAL')) } as any;
    await expect(new ClinicalEventService({ query: jest.fn() } as any, fakeAudit, safeguardingOnly).getFullEvent('e', 'officer')).rejects.toThrow();
  });
});

describe('SafeguardingService', () => {
  it('accepts an unregistered-child report when subject details are given', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ n: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'i1', incident_ref: 'SG-NBI-2026-00001', status: 'REPORTED', is_unregistered_child: true }] }) } as any;
    const r = await new SafeguardingService(db, fakeAudit, allow).reportIncident({ category: 'SG-02', severity: 'LEVEL_2', description: 'x', reportedSubjectName: 'Unnamed', reportedSubjectAge: 7 }, 'rep');
    expect(r.is_unregistered_child).toBe(true);
  });

  it('rejects an unregistered-child report with no identifying detail', async () => {
    await expect(new SafeguardingService({ query: jest.fn() } as any, fakeAudit, allow).reportIncident({ category: 'SG-02', severity: 'LEVEL_2', description: 'x' }, 'rep')).rejects.toThrow();
  });

  it('rejects an invalid severity', async () => {
    await expect(new SafeguardingService({ query: jest.fn() } as any, fakeAudit, allow).reportIncident({ category: 'SG-02', severity: 'LEVEL_9', description: 'x', beneficiaryId: 'b' }, 'rep')).rejects.toThrow();
  });

  it('linkToBeneficiary writes the linking event BEFORE updating the incident', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ beneficiary_id: null, is_unregistered_child: true }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) } as any;
    await new SafeguardingService(db, fakeAudit, allow).linkToBeneficiary('i', 'b', 'officer', 'verified');
    expect(String(db.query.mock.calls[1][0])).toContain('safeguarding_linking_events');
    expect(String(db.query.mock.calls[2][0])).toContain('UPDATE safeguarding_incidents');
  });

  it('refuses to link an incident that is already registered', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ beneficiary_id: 'x', is_unregistered_child: false }] }) } as any;
    await expect(new SafeguardingService(db, fakeAudit, allow).linkToBeneficiary('i', 'b2', 'officer', 'r')).rejects.toThrow();
  });

  it('refuses to assign an incident to a declared conflict of interest', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }) } as any;
    await expect(new SafeguardingService(db, fakeAudit, allow).assignIncident('i', 'implicated-user', 'officer')).rejects.toThrow();
  });

  it('assigns normally when there is no declared conflict', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }) } as any;
    const r = await new SafeguardingService(db, fakeAudit, allow).assignIncident('i', 'other', 'officer');
    expect(r.assignedTo).toBe('other');
  });

  it('state-changing actions require SAFEGUARDING:WRITE', async () => {
    const deny = { hasAtLeast: jest.fn().mockResolvedValue(false) } as any;
    await expect(new SafeguardingService({ query: jest.fn() } as any, fakeAudit, deny).transition('i', 'SCREENING', 'x')).rejects.toThrow();
  });
});
