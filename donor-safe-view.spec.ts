import { DonorSafeViewService } from '../src/modules/donor/donor-safe-view.service';

/**
 * The donor-safe projection is the highest-stakes new code in this
 * module — it's the boundary preventing a donor from ever seeing a
 * child's full name, address, school, or clinical detail.
 */
describe('DonorSafeViewService', () => {
  const fakeAudit = { recordDataAccess: jest.fn() } as any;

  it('refuses access when the donor does not own this sponsorship', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) } as any;
    const service = new DonorSafeViewService(db, fakeAudit);
    await expect(service.getSponsoredChildProfile('donor-1', 'sponsorship-999')).rejects.toThrow();
  });

  it('refuses access for a non-NAMED_CHILD sponsorship', async () => {
    const db = { query: jest.fn().mockResolvedValueOnce({ rows: [{ beneficiary_id: null, sponsorship_type: 'GENERAL' }] }) } as any;
    const service = new DonorSafeViewService(db, fakeAudit);
    await expect(service.getSponsoredChildProfile('donor-1', 'sponsorship-1')).rejects.toThrow();
  });

  it('returns only the enumerated safe fields — never full name, address, or clinical data', async () => {
    const db = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [{ beneficiary_id: 'ben-1', sponsorship_type: 'NAMED_CHILD' }] })
        .mockResolvedValueOnce({ rows: [{ beneficiary_ref: 'SCF-NRB-000123', date_of_birth: '2017-01-01', county: 'Nairobi' }] })
        .mockResolvedValueOnce({ rows: [{ category: 'MEDICATION' }] })
        .mockResolvedValueOnce({ rows: [{ service_type: 'Medication', confirmed_at: '2026-08-01' }] }),
    } as any;
    const service = new DonorSafeViewService(db, fakeAudit);
    const profile = await service.getSponsoredChildProfile('donor-1', 'sponsorship-1');

    expect(profile.beneficiaryRef).toBe('SCF-NRB-000123');
    expect(profile.county).toBe('Nairobi');
    expect(profile.ageGroup).toMatch(/^\d/); // a bucketed band, not an exact age
    expect(Object.keys(profile)).toEqual(['beneficiaryRef', 'ageGroup', 'county', 'programmeSummary', 'latestSupportSummary', 'status']);
    // No key resembling name, address, school, phone, or diagnosis exists anywhere in the shape.
    const forbidden = ['name', 'address', 'school', 'phone', 'diagnosis', 'medical'];
    const keys = Object.keys(profile).map((k) => k.toLowerCase());
    forbidden.forEach((f) => expect(keys.some((k) => k.includes(f))).toBe(false));
  });
});
