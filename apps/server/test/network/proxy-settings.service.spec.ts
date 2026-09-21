import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../src/audit/audit.service';
import type { AuthenticatedAdmin } from '../../src/auth/auth.types';
import type { PrismaService } from '../../src/database/prisma.service';
import { ProxyMode, ProxyProtocol, VpnConfigType } from '../../src/network/proxy-settings.dto';
import {
  NETPROXY_STATE_DIR,
  ProxySettingsService,
  type ProxySetting,
} from '../../src/network/proxy-settings.service';
import type { CryptoService } from '../../src/security/crypto.service';

const actor = { id: 'admin-id' } as AuthenticatedAdmin;

function createService(initial: Partial<ProxySetting> | null = null) {
  let current: Partial<ProxySetting> | null = initial;
  const upsert = vi
    .fn<(args: { create: { value: ProxySetting } }) => Promise<void>>()
    .mockImplementation((args) => {
      current = args.create.value;
      return Promise.resolve(undefined);
    });
  const record = vi.fn<AuditService['record']>().mockResolvedValue(undefined);
  const prisma = {
    systemSetting: {
      findUnique: vi
        .fn<() => Promise<{ value: Partial<ProxySetting> } | null>>()
        .mockImplementation(() => Promise.resolve(current ? { value: current } : null)),
      upsert,
    },
  } as unknown as PrismaService;
  const crypto = {
    encrypt: vi.fn((plaintext: string) => `enc:${plaintext}`),
    decrypt: vi.fn((ciphertext: string) => ciphertext.replace(/^enc:/u, '')),
  } as unknown as CryptoService;
  const audit = { record } as unknown as AuditService;
  return { service: new ProxySettingsService(prisma, crypto, audit), upsert, record };
}

const baseDto = {
  enabled: true,
  mode: ProxyMode.FAILOVER,
  applyToGateway: true,
  applyToSystem: false,
  protocol: ProxyProtocol.SOCKS5,
  host: 'proxy.example.com',
  port: 1080,
  healthCheckHost: '1.1.1.1',
  healthCheckPort: 443,
  healthCheckIntervalSeconds: 30,
  healthCheckFailureThreshold: 3,
  vpnConfigType: VpnConfigType.NONE,
};

describe('ProxySettingsService', () => {
  afterEach(() => {
    rmSync(NETPROXY_STATE_DIR, { recursive: true, force: true });
  });

  it('returns disabled defaults when nothing is stored', async () => {
    const { service } = createService(null);
    const settings = await service.get();
    expect(settings.enabled).toBe(false);
    expect(settings.host).toBe('');
  });

  it('rejects gateway scope without a host', async () => {
    const { service } = createService(null);
    await expect(service.update({ ...baseDto, host: '' }, actor)).rejects.toThrow(
      'A proxy host is required',
    );
  });

  it('rejects system scope without selecting a VPN type', async () => {
    const { service } = createService(null);
    await expect(
      service.update({ ...baseDto, applyToSystem: true, vpnConfigType: VpnConfigType.NONE }, actor),
    ).rejects.toThrow('System-wide proxying requires');
  });

  it('rejects enabling system scope before a VPN config has ever been uploaded', async () => {
    const { service } = createService(null);
    await expect(
      service.update(
        {
          ...baseDto,
          applyToSystem: true,
          vpnConfigType: VpnConfigType.OPENVPN,
          vpnConfig: undefined,
        },
        actor,
      ),
    ).rejects.toThrow('Upload a VPN configuration');
  });

  it('encrypts and stores the password, and never returns it from safe()', async () => {
    const { service, upsert } = createService(null);
    const result = await service.update({ ...baseDto, password: 'hunter2' }, actor);
    expect(result.hasPassword).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hunter2');
    const stored = upsert.mock.calls[0]?.[0].create.value;
    expect(stored?.passwordCiphertext).toBe('enc:hunter2');
  });

  it('keeps the existing password when the update omits it', async () => {
    const { service } = createService({ ...baseDto, passwordCiphertext: 'enc:hunter2' });
    const result = await service.update(baseDto, actor);
    expect(result.hasPassword).toBe(true);
  });

  it('clears the password when an empty string is sent', async () => {
    const { service } = createService({ ...baseDto, passwordCiphertext: 'enc:hunter2' });
    const result = await service.update({ ...baseDto, password: '' }, actor);
    expect(result.hasPassword).toBe(false);
  });

  it('redacts secrets in the audit trail', async () => {
    const { service, record } = createService(null);
    await service.update({ ...baseDto, password: 'hunter2' }, actor);
    const call = record.mock.calls[0]?.[0];
    expect(JSON.stringify(call)).not.toContain('hunter2');
  });
});
