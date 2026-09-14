import Decimal from 'decimal.js';

export interface WeightedItem<T> {
  key: T;
  weight: Decimal.Value;
}

export interface AllocatedItem<T> {
  key: T;
  amount: bigint;
}

export function largestRemainder<T>(total: bigint, items: WeightedItem<T>[]): AllocatedItem<T>[] {
  if (total < 0n) throw new Error('Total cannot be negative');
  if (!items.length) return [];
  const totalWeight = items.reduce((sum, item) => sum.add(item.weight), new Decimal(0));
  if (totalWeight.lte(0)) throw new Error('Allocation weight must be positive');
  const calculated = items.map((item, index) => {
    const exact = new Decimal(total.toString()).mul(item.weight).div(totalWeight);
    const floor = BigInt(exact.floor().toFixed(0));
    return { key: item.key, amount: floor, remainder: exact.sub(floor.toString()), index };
  });
  let missing = total - calculated.reduce((sum, item) => sum + item.amount, 0n);
  calculated.sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  for (let index = 0; missing > 0n; index = (index + 1) % calculated.length) {
    calculated[index]!.amount += 1n;
    missing -= 1n;
  }
  calculated.sort((a, b) => a.index - b.index);
  return calculated.map(({ key, amount }) => ({ key, amount }));
}

export function splitBasisPoints(
  total: bigint,
  customerBps: number,
): { customer: bigint; operator: bigint } {
  if (!Number.isInteger(customerBps) || customerBps < 0 || customerBps > 10_000) {
    throw new Error('customerBps must be an integer between 0 and 10000');
  }
  const customer = (total * BigInt(customerBps)) / 10_000n;
  return { customer, operator: total - customer };
}
