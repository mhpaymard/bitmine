import { describe, expect, it } from 'vitest';
import { totpCode, verifyTotp } from '../../src/auth/totp';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('TOTP', () => {
  it.each([
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_111_111_111_000, '050471'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
  ])('matches RFC 6238 SHA-1 vectors truncated to six digits at %i', (time, expected) => {
    expect(totpCode(RFC_SECRET, time)).toBe(expected);
  });

  it('accepts one clock step of skew and rejects malformed codes', () => {
    const time = 1_234_567_890_000;
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, time - 30_000), time)).toBe(true);
    expect(verifyTotp(RFC_SECRET, '12345', time)).toBe(false);
  });
});
