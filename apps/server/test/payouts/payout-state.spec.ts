import { PayoutState } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { assertPayoutTransition, canTransitionPayout } from '../../src/payouts/payout-state';

describe('payout state machine', () => {
  it('allows the normal approval and settlement path', () => {
    expect(canTransitionPayout(PayoutState.APPROVAL_REQUIRED, PayoutState.AUTO_APPROVED)).toBe(
      true,
    );
    expect(canTransitionPayout(PayoutState.AUTO_APPROVED, PayoutState.SIGNED)).toBe(true);
    expect(canTransitionPayout(PayoutState.SIGNED, PayoutState.BROADCAST)).toBe(true);
    expect(canTransitionPayout(PayoutState.BROADCAST, PayoutState.CONFIRMED)).toBe(true);
  });

  it('does not allow replay from a confirmed batch', () => {
    expect(() => assertPayoutTransition(PayoutState.CONFIRMED, PayoutState.BROADCAST)).toThrow(
      /Invalid/u,
    );
  });

  it('allows crash recovery from a signed failed batch', () => {
    expect(canTransitionPayout(PayoutState.FAILED, PayoutState.BROADCAST)).toBe(true);
  });
});
