import { describe, expect, it } from 'vitest';
import { BitcoinPoolAdapter, MoneroPoolAdapter } from '../../src/gateway/pool-adapters';

describe('pool normalized work', () => {
  it('normalizes Bitcoin difficulty into difficulty-one hashes', () => {
    expect(new BitcoinPoolAdapter().normalizedWork('1')).toBe('4294967296.000000000000000000');
  });

  it('keeps RandomX difficulty exact', () => {
    expect(new MoneroPoolAdapter().normalizedWork('123.5')).toBe('123.500000000000000000');
  });

  it('decodes Monero little-endian targets', () => {
    const adapter = new MoneroPoolAdapter();
    expect(adapter.difficultyFromTarget('ffffffff')).toBe('1');
    expect(adapter.difficultyFromTarget('ffffff7f')).toBe('2');
    expect(adapter.difficultyFromTarget('not-hex')).toBe('1');
  });
});
