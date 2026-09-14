import { describe, expect, it } from 'vitest';
import { ASSET_CODES, BASIS_POINTS } from './index.js';

describe('shared financial constants', () => {
  it('keeps supported assets and basis points stable', () => {
    expect(ASSET_CODES).toEqual(['BTC', 'XMR']);
    expect(BASIS_POINTS).toBe(10_000);
  });
});
