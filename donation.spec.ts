import { DonationService } from '../src/modules/donor/donation.service';
import { fakeDbWithTx } from './helpers';

describe('DonationService', () => {
  const fakeAudit = { record: jest.fn() } as any;
  const fakeNotifications = { create: jest.fn() } as any;
  beforeEach(() => jest.clearAllMocks());

  it('confirmReceived is idempotent — replaying returns RECEIVED without re-posting to the ledger or notifying again', async () => {
    const fakeLedger = { post: jest.fn() } as any;
    const { db } = fakeDbWithTx({
      queries: [[]], // no other donation claims this external ref
      clientQueries: [[{ status: 'RECEIVED', amount: '5000', fund_id: 'f1', donation_ref: 'SCF-DON-000001', donor_user_id: 'donor-1' }]],
    });
    const service = new DonationService(db, fakeAudit, fakeLedger, fakeNotifications);
    const result = await service.confirmReceived('don-1', 'EXT-REF-1', 'actor-1');
    expect(result.status).toBe('RECEIVED');
    expect(fakeLedger.post).not.toHaveBeenCalled();
    expect(fakeNotifications.create).not.toHaveBeenCalled();
  });

  it('posts to the ledger INSIDE the same transaction client on first confirmation, and notifies the donor afterwards', async () => {
    const fakeLedger = { post: jest.fn() } as any;
    const { db, client } = fakeDbWithTx({
      queries: [[]],
      clientQueries: [[{ status: 'PLEDGED', amount: '5000', fund_id: 'f1', donation_ref: 'SCF-DON-000002', donor_user_id: 'donor-2' }], []],
    });
    const service = new DonationService(db, fakeAudit, fakeLedger, fakeNotifications);
    await service.confirmReceived('don-2', 'EXT-REF-2', 'actor-1');
    expect(fakeLedger.post).toHaveBeenCalledTimes(1);
    // The second argument must be the transaction client — this is the atomicity fix.
    expect(fakeLedger.post.mock.calls[0][1]).toBe(client);
    expect(fakeNotifications.create).toHaveBeenCalledWith('donor-2', 'DONATION_RECEIVED', expect.any(String), expect.any(String), expect.objectContaining({ donationId: 'don-2' }));
  });

  it('does not notify when the donation has no donor_user_id (anonymous/offline donation)', async () => {
    const fakeLedger = { post: jest.fn() } as any;
    const { db } = fakeDbWithTx({
      queries: [[]],
      clientQueries: [[{ status: 'PLEDGED', amount: '5000', fund_id: 'f1', donation_ref: 'SCF-DON-000003', donor_user_id: null }], []],
    });
    const service = new DonationService(db, fakeAudit, fakeLedger, fakeNotifications);
    await service.confirmReceived('don-3', 'EXT-REF-3', 'actor-1');
    expect(fakeNotifications.create).not.toHaveBeenCalled();
  });

  it('rejects confirming a donation that is not PLEDGED', async () => {
    const { db } = fakeDbWithTx({ queries: [[]], clientQueries: [[{ status: 'CANCELLED', amount: '5000', fund_id: 'f1', donation_ref: 'x' }]] });
    const service = new DonationService(db, fakeAudit, { post: jest.fn() } as any, fakeNotifications);
    await expect(service.confirmReceived('don-4', 'EXT-REF-4', 'actor-1')).rejects.toThrow();
  });

  it('rejects an external reference already attached to a different donation', async () => {
    const { db } = fakeDbWithTx({ queries: [[{ id: 'other-donation', status: 'RECEIVED' }]] });
    const service = new DonationService(db, fakeAudit, { post: jest.fn() } as any, fakeNotifications);
    await expect(service.confirmReceived('don-5', 'EXT-REF-DUP', 'actor-1')).rejects.toThrow();
  });

  it('rejects a zero/negative donation amount', async () => {
    const service = new DonationService({ query: jest.fn() } as any, fakeAudit, { post: jest.fn() } as any, fakeNotifications);
    await expect(service.pledge({ fundId: 'f1', amount: 0 }, 'actor-1')).rejects.toThrow();
  });
});
