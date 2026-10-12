import { PaymentService } from '../src/modules/finance/payment.service';
import { AllocationService } from '../src/modules/finance/allocation.service';
import { CommitmentService } from '../src/modules/finance/commitment.service';
import { ReconciliationService } from '../src/modules/finance/reconciliation.service';
import { LedgerService } from '../src/modules/finance/ledger.service';
import { fakeDbWithTx } from './helpers';

const fakeAudit = { record: jest.fn() } as any;
beforeEach(() => jest.clearAllMocks());

describe('LedgerService', () => {
  it('rejects an unbalanced transaction before touching the database', async () => {
    const db = { query: jest.fn(), withTransaction: jest.fn() } as any;
    const ledger = new LedgerService(db);
    await expect(ledger.post({
      transactionType: 'X', createdBy: 'u',
      entries: [{ accountCode: 'A', debit: 100 }, { accountCode: 'B', credit: 90 }],
    })).rejects.toThrow();
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  it('rejects a single-entry transaction', async () => {
    const db = { query: jest.fn(), withTransaction: jest.fn() } as any;
    await expect(new LedgerService(db).post({ transactionType: 'X', createdBy: 'u', entries: [{ accountCode: 'A', debit: 100 }] })).rejects.toThrow();
  });

  it('joins the caller\'s transaction instead of opening its own when given a client', async () => {
    const clientQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{ n: '1' }] })            // nextval
      .mockResolvedValueOnce({ rows: [{ id: 'tx-1' }] })        // INSERT transaction
      .mockResolvedValue({ rows: [{ id: 'acct-1', is_placeholder: false }] }); // account lookups + entry inserts
    const db = { query: jest.fn(), withTransaction: jest.fn() } as any;
    const ledger = new LedgerService(db);
    await ledger.post({ transactionType: 'X', createdBy: 'u', entries: [{ accountCode: 'A', debit: 100 }, { accountCode: 'B', credit: 100 }] }, { query: clientQuery } as any);
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(clientQuery).toHaveBeenCalled();
  });
});

describe('PaymentService', () => {
  it('idempotency: replaying the same key returns the existing payment, never a second one', async () => {
    const existing = { id: 'p1', payment_ref: 'SCF-PAY-000001', status: 'PROCESSING' };
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [existing] }) } as any;
    const service = new PaymentService(db, fakeAudit, { post: jest.fn() } as any);
    const result = await service.create({ commitmentId: 'c', providerId: 'p', amount: 5000, idempotencyKey: 'k1', actorId: 'u' });
    expect(result).toEqual(existing);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('resolveUncertain rejects a payment that is not UNCERTAIN', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ status: 'PROCESSING' }] }) } as any;
    await expect(new PaymentService(db, fakeAudit, { post: jest.fn() } as any).resolveUncertain('p', 'PAID', 'u', 'evidence')).rejects.toThrow();
  });

  it('moving to PAID posts to the ledger using the SAME transaction client (atomicity)', async () => {
    const ledger = { post: jest.fn() } as any;
    const { db, client } = fakeDbWithTx({ clientQueries: [[{ status: 'PROCESSING', amount: '5000' }], []] });
    const service = new PaymentService(db, fakeAudit, ledger);
    await service.markUncertain('p1', 'u', 'timeout'); // PROCESSING -> UNCERTAIN: no ledger post
    expect(ledger.post).not.toHaveBeenCalled();

    const t2 = fakeDbWithTx({ clientQueries: [[{ status: 'UNCERTAIN', amount: '5000' }], []], queries: [[{ status: 'UNCERTAIN' }]] });
    const svc2 = new PaymentService(t2.db, fakeAudit, ledger);
    await svc2.resolveUncertain('p1', 'PAID', 'u', 'bank statement');
    expect(ledger.post).toHaveBeenCalledTimes(1);
    expect(ledger.post.mock.calls[0][1]).toBe(t2.client);
    expect(client).toBeDefined();
  });

  it('rejects an invalid transition (DRAFT -> PAID)', async () => {
    const { db } = fakeDbWithTx({ clientQueries: [[{ status: 'DRAFT', amount: '5000' }]] });
    const svc = new PaymentService(db, fakeAudit, { post: jest.fn() } as any);
    await expect((svc as any).transition('p', 'PAID', 'u')).rejects.toThrow();
  });
});

describe('AllocationService — fund restriction enforcement (FIN-009)', () => {
  const ledger = () => ({ getFundLedgerBalance: jest.fn().mockResolvedValue(100000), post: jest.fn() } as any);

  it('blocks an allocation to a category the fund restriction does not cover', async () => {
    const { db } = fakeDbWithTx({ clientQueries: [[{ restriction_type: 'MEDICATION', programme_code: 'MEDICATION', beneficiary_id: null }], [{ category: 'EDUCATION' }]] });
    await expect(new AllocationService(db, fakeAudit, ledger()).allocate({ fundId: 'f', amount: 5000, interventionId: 'i' }, 'u')).rejects.toThrow();
  });

  it('allows an allocation matching the fund restriction, and posts to the ledger in the same transaction', async () => {
    const l = ledger();
    const { db, client } = fakeDbWithTx({ clientQueries: [
      [{ restriction_type: 'MEDICATION', programme_code: 'MEDICATION', beneficiary_id: null }],
      [{ category: 'MEDICATION' }], [{ n: '1' }], [{ id: 'a1', allocation_ref: 'SCF-ALC-000001', status: 'APPROVED' }],
    ] });
    const result = await new AllocationService(db, fakeAudit, l).allocate({ fundId: 'f', amount: 5000, interventionId: 'i' }, 'u');
    expect(result.status).toBe('APPROVED');
    expect(l.post.mock.calls[0][1]).toBe(client);
  });

  it('allows any allocation on an unrestricted fund', async () => {
    const { db } = fakeDbWithTx({ clientQueries: [[], [{ n: '2' }], [{ id: 'a2', allocation_ref: 'SCF-ALC-000002', status: 'APPROVED' }]] });
    const result = await new AllocationService(db, fakeAudit, ledger()).allocate({ fundId: 'f', amount: 5000, beneficiaryId: 'b' }, 'u');
    expect(result.status).toBe('APPROVED');
  });

  it('rejects an allocation larger than the available fund balance, before opening a transaction', async () => {
    const l = { getFundLedgerBalance: jest.fn().mockResolvedValue(1000), post: jest.fn() } as any;
    const { db } = fakeDbWithTx({});
    await expect(new AllocationService(db, fakeAudit, l).allocate({ fundId: 'f', amount: 5000 }, 'u')).rejects.toThrow();
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});

describe('CommitmentService — remaining-balance check', () => {
  it('rejects a commitment that would over-commit the allocation', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ amount: '10000' }] }).mockResolvedValueOnce({ rows: [{ total: '8000' }] }) } as any;
    await expect(new CommitmentService(db, fakeAudit).create('a', 5000, 'u')).rejects.toThrow();
  });
  it('allows a commitment within the remaining balance', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ amount: '10000' }] }).mockResolvedValueOnce({ rows: [{ total: '3000' }] })
      .mockResolvedValueOnce({ rows: [{ n: '1' }] }).mockResolvedValueOnce({ rows: [{ id: 'c1', commitment_ref: 'SCF-CMT-000001', status: 'PROPOSED' }] }) } as any;
    expect((await new CommitmentService(db, fakeAudit).create('a', 5000, 'u')).status).toBe('PROPOSED');
  });
});

describe('ReconciliationService', () => {
  it('marks payment RECONCILED when amounts match', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'PAID', amount: '5000' }] }).mockResolvedValueOnce({ rows: [{ n: '1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r1', reconciliation_ref: 'SCF-REC-000001', status: 'MATCHED' }] }).mockResolvedValueOnce({ rows: [] }) } as any;
    expect((await new ReconciliationService(db, fakeAudit).reconcile('p', 'X', 5000, 5000, 'u')).status).toBe('MATCHED');
    expect(db.query).toHaveBeenCalledTimes(4);
  });
  it('leaves the payment open as an EXCEPTION on mismatch', async () => {
    const db = { query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ status: 'PAID', amount: '5000' }] }).mockResolvedValueOnce({ rows: [{ n: '2' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'r2', reconciliation_ref: 'SCF-REC-000002', status: 'EXCEPTION' }] }) } as any;
    expect((await new ReconciliationService(db, fakeAudit).reconcile('p', 'X', 5000, 4800, 'u')).status).toBe('EXCEPTION');
    expect(db.query).toHaveBeenCalledTimes(3);
  });
  it('refuses to reconcile a payment that is not PAID', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [{ status: 'PROCESSING', amount: '5000' }] }) } as any;
    await expect(new ReconciliationService(db, fakeAudit).reconcile('p', 'X', 5000, 5000, 'u')).rejects.toThrow();
  });
});
