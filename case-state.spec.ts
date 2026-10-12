import { isValidCaseTransition, isValidNeedTransition, isValidInterventionTransition, isValidProviderTransition, isValidServiceTransition, isValidSponsorshipTransition } from '../src/modules/care/case-state';

describe('Case state machine', () => {
  it('allows DRAFT -> SUBMITTED', () => { expect(isValidCaseTransition('DRAFT', 'SUBMITTED')).toBe(true); });
  it('rejects CLOSED -> ACTIVE directly', () => { expect(isValidCaseTransition('CLOSED', 'ACTIVE')).toBe(false); });
});
describe('Intervention state machine', () => {
  it('requires FUNDED before AUTHORISED', () => {
    expect(isValidInterventionTransition('APPROVED', 'AUTHORISED')).toBe(false);
    expect(isValidInterventionTransition('FUNDED', 'AUTHORISED')).toBe(true);
  });
});
describe('Sponsorship state machine', () => {
  it('allows PROPOSED -> ACTIVE', () => { expect(isValidSponsorshipTransition('PROPOSED', 'ACTIVE')).toBe(true); });
  it('allows ACTIVE -> PAUSED -> ACTIVE', () => {
    expect(isValidSponsorshipTransition('ACTIVE', 'PAUSED')).toBe(true);
    expect(isValidSponsorshipTransition('PAUSED', 'ACTIVE')).toBe(true);
  });
  it('ENDED is terminal', () => { expect(isValidSponsorshipTransition('ENDED', 'ACTIVE')).toBe(false); });
});
