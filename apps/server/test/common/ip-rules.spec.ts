import { describe, expect, it } from 'vitest';
import { ipAllowed, isValidIpRule } from '../../src/common/ip-rules';

describe('worker IP allow rules', () => {
  it('supports exact and CIDR rules for IPv4 and IPv6', () => {
    expect(ipAllowed('::ffff:10.2.3.4', ['10.0.0.0/8'])).toBe(true);
    expect(ipAllowed('192.168.1.5', ['10.0.0.0/8'])).toBe(false);
    expect(ipAllowed('2001:db8::1234', ['2001:db8::/32'])).toBe(true);
    expect(ipAllowed('2001:db9::1', ['2001:db8::/32'])).toBe(false);
    expect(ipAllowed('127.0.0.1', [])).toBe(true);
  });

  it('rejects malformed addresses and out-of-range prefixes', () => {
    expect(isValidIpRule('10.0.0.0/33')).toBe(false);
    expect(isValidIpRule('2001:db8::/129')).toBe(false);
    expect(isValidIpRule('not-an-ip')).toBe(false);
    expect(ipAllowed('not-an-ip', ['0.0.0.0/0'])).toBe(false);
  });
});
