import { describe, expect, it } from 'vitest';
import { largestRemainder, splitBasisPoints } from '../../src/ledger/allocation';

describe('largestRemainder', () => {
  it('allocates every atomic unit without drift', () => {
    const result = largestRemainder(101n, [
      { key: 'a', weight: '1' },
      { key: 'b', weight: '1' },
      { key: 'c', weight: '1' },
    ]);
    expect(result).toEqual([
      { key: 'a', amount: 34n },
      { key: 'b', amount: 34n },
      { key: 'c', amount: 33n },
    ]);
    expect(result.reduce((sum, item) => sum + item.amount, 0n)).toBe(101n);
  });

  it('handles financial integer values larger than Number.MAX_SAFE_INTEGER', () => {
    const total = 9_223_372_036_854_775_000n;
    const result = largestRemainder(total, [
      { key: 'one', weight: '0.123456789012345678' },
      { key: 'two', weight: '0.876543210987654322' },
    ]);
    expect(result.reduce((sum, item) => sum + item.amount, 0n)).toBe(total);
  });

  it('rejects a non-positive total weight', () => {
    expect(() => largestRemainder(1n, [{ key: 'a', weight: '0' }])).toThrow(/positive/u);
  });
});

describe('splitBasisPoints', () => {
  it('keeps the 80/20 split balanced after integer rounding', () => {
    const split = splitBasisPoints(101n, 8000);
    expect(split).toEqual({ customer: 80n, operator: 21n });
    expect(split.customer + split.operator).toBe(101n);
  });

  it('enforces the basis point range', () => {
    expect(() => splitBasisPoints(100n, 10_001)).toThrow(/10000/u);
  });
});
