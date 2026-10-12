import { CaseService } from '../src/modules/care/case.service';
import { NeedService } from '../src/modules/care/need.service';
import { InterventionService } from '../src/modules/care/intervention.service';
import { ProviderService } from '../src/modules/provider/provider.service';

/** Closes docs/OPEN_ITEMS.md #23 — Care/Provider services previously had zero test coverage. */
describe('CaseService', () => {
  const fakeAudit = { record: jest.fn() } as any;

  it('rejects an invalid transition', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ status: 'DRAFT' }] }) } as any;
    const service = new CaseService(db, fakeAudit);
    await expect(service.transition({ caseId: 'c1', toStatus: 'CLOSED', reason: 'test', actorId: 'u1' })).rejects.toThrow();
  });

  it('allows a valid transition and audits it', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ status: 'DRAFT' }] }).mockResolvedValueOnce({ rows: [] }) } as any;
    const service = new CaseService(db, fakeAudit);
    const result = await service.transition({ caseId: 'c1', toStatus: 'SUBMITTED', reason: 'ready', actorId: 'u1' });
    expect(result.status).toBe('SUBMITTED');
    expect(fakeAudit.record).toHaveBeenCalled();
  });
});

describe('NeedService', () => {
  const fakeAudit = { record: jest.fn() } as any;
  it('rejects an invalid need category on create', async () => {
    const db = { query: jest.fn() } as any;
    const service = new NeedService(db, fakeAudit);
    await expect(service.create({ caseId: 'c1', category: 'NOT_REAL', title: 'x', priority: 'NORMAL' }, 'u1')).rejects.toThrow();
  });
});

describe('InterventionService', () => {
  const fakeAudit = { record: jest.fn() } as any;
  const fakeProviders = { assertEligibleForService: jest.fn() } as any;

  it('rejects AUTHORISED without a providerId', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ status: 'FUNDED' }] }) } as any;
    const service = new InterventionService(db, fakeAudit, fakeProviders);
    await expect(service.transition('int-1', 'AUTHORISED', 'reason', 'u1')).rejects.toThrow();
  });

  it('checks provider eligibility before allowing AUTHORISED', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ status: 'FUNDED' }] }).mockResolvedValueOnce({ rows: [] }) } as any;
    const service = new InterventionService(db, fakeAudit, fakeProviders);
    await service.transition('int-1', 'AUTHORISED', 'reason', 'u1', { providerId: 'p1' });
    expect(fakeProviders.assertEligibleForService).toHaveBeenCalledWith('p1');
  });
});

describe('ProviderService', () => {
  const fakeAudit = { record: jest.fn() } as any;
  it('assertEligibleForService rejects a non-ACTIVE provider', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ status: 'SUSPENDED' }] }) } as any;
    const service = new ProviderService(db, fakeAudit);
    await expect(service.assertEligibleForService('p1')).rejects.toThrow();
  });
  it('assertEligibleForService allows an ACTIVE provider', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ status: 'ACTIVE' }] }) } as any;
    const service = new ProviderService(db, fakeAudit);
    await expect(service.assertEligibleForService('p1')).resolves.not.toThrow();
  });
});
