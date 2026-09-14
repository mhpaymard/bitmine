import { PayoutState } from '@prisma/client';

const TRANSITIONS: Readonly<Record<PayoutState, readonly PayoutState[]>> = {
  [PayoutState.PLANNED]: [
    PayoutState.APPROVAL_REQUIRED,
    PayoutState.AUTO_APPROVED,
    PayoutState.FAILED,
    PayoutState.CANCELLED,
  ],
  [PayoutState.APPROVAL_REQUIRED]: [
    PayoutState.AUTO_APPROVED,
    PayoutState.FAILED,
    PayoutState.CANCELLED,
  ],
  [PayoutState.AUTO_APPROVED]: [PayoutState.SIGNED, PayoutState.FAILED, PayoutState.CANCELLED],
  [PayoutState.SIGNED]: [PayoutState.BROADCAST, PayoutState.FAILED],
  [PayoutState.BROADCAST]: [PayoutState.CONFIRMED, PayoutState.FAILED],
  [PayoutState.CONFIRMED]: [],
  [PayoutState.FAILED]: [PayoutState.AUTO_APPROVED, PayoutState.SIGNED, PayoutState.BROADCAST],
  [PayoutState.CANCELLED]: [],
};

export function canTransitionPayout(from: PayoutState, to: PayoutState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertPayoutTransition(from: PayoutState, to: PayoutState): void {
  if (!canTransitionPayout(from, to))
    throw new Error(`Invalid payout transition: ${from} -> ${to}`);
}
