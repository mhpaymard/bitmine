import { BlockList, isIP } from 'node:net';

function parsedRule(
  rule: string,
): { address: string; type: 'ipv4' | 'ipv6'; prefix?: number } | undefined {
  const normalized = rule.trim();
  const slash = normalized.lastIndexOf('/');
  const address = slash < 0 ? normalized : normalized.slice(0, slash);
  const version = isIP(address);
  if (!version) return undefined;
  if (slash < 0) return { address, type: version === 4 ? 'ipv4' : 'ipv6' };
  const prefix = Number(normalized.slice(slash + 1));
  const maximum = version === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maximum) return undefined;
  return { address, type: version === 4 ? 'ipv4' : 'ipv6', prefix };
}

export function isValidIpRule(rule: string): boolean {
  return parsedRule(rule) !== undefined;
}

export function ipAllowed(remoteIp: string, rules: string[]): boolean {
  if (!rules.length) return true;
  const normalized = remoteIp.replace(/^::ffff:/u, '');
  const remoteVersion = isIP(normalized);
  if (!remoteVersion) return false;
  return rules.some((rule) => {
    const parsed = parsedRule(rule);
    if (!parsed || parsed.type !== (remoteVersion === 4 ? 'ipv4' : 'ipv6')) return false;
    const blockList = new BlockList();
    if (parsed.prefix === undefined) blockList.addAddress(parsed.address, parsed.type);
    else blockList.addSubnet(parsed.address, parsed.prefix, parsed.type);
    return blockList.check(normalized, parsed.type);
  });
}
