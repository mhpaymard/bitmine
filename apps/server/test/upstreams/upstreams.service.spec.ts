import { AssetCode, PoolProtocol } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { ProxyHealthService } from '../../src/network/proxy-health.service';
import type { CryptoService } from '../../src/security/crypto.service';
import { UpstreamsService } from '../../src/upstreams/upstreams.service';
import type { WalletsService } from '../../src/wallets/wallets.service';
import { FakeBitcoinPool, FakeMoneroPool } from '../fakes/fake-pools';

const pools: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.stop()));
});

function upstream(protocol: PoolProtocol, port: number) {
  return {
    id: 'upstream-id',
    accountKey: 'account-id',
    asset: protocol === PoolProtocol.BITCOIN_STRATUM_V1 ? AssetCode.BTC : AssetCode.XMR,
    protocol,
    name: 'fake-pool',
    host: '127.0.0.1',
    port,
    tls: false,
    priority: 1,
    enabled: true,
    usernameTemplate: 'service.{customer}.{worker}',
    passwordCiphertext: 'encrypted-password',
    receiveAddress: null,
    connectionTimeoutMs: 1_000,
    failbackCooldownSeconds: 30,
    lastHealthAt: null,
    lastHealthOk: null,
    lastHealthMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function serviceFor(record: ReturnType<typeof upstream>) {
  const update = vi
    .fn<(input: { data: { lastHealthOk: boolean } }) => Promise<typeof record>>()
    .mockResolvedValue(record);
  const prisma = {
    upstream: { findUnique: vi.fn().mockResolvedValue(record), update },
  } as unknown as PrismaService;
  const crypto = {
    decrypt: vi.fn().mockReturnValue('secret'),
  } as unknown as CryptoService;
  const proxyHealth = {
    resolveGatewayProxy: vi.fn().mockResolvedValue(null),
  } as unknown as ProxyHealthService;
  return {
    service: new UpstreamsService(
      prisma,
      crypto,
      {} as AuditService,
      {} as WalletsService,
      proxyHealth,
    ),
    update,
  };
}

describe('upstream protocol health check', () => {
  it('subscribes and authenticates against a Bitcoin Stratum endpoint', async () => {
    const pool = new FakeBitcoinPool();
    pools.push(pool);
    await pool.start();
    const { service, update } = serviceFor(upstream(PoolProtocol.BITCOIN_STRATUM_V1, pool.port));

    await expect(service.test('upstream-id')).resolves.toMatchObject({
      ok: true,
      message: 'Stratum protocol and authentication successful',
    });
    expect(pool.messages.map((message) => message.method)).toEqual([
      'mining.subscribe',
      'mining.authorize',
    ]);
    expect(pool.messages[1]?.params).toEqual(['service.health.probe', 'secret']);
    expect(update.mock.calls[0]?.[0].data.lastHealthOk).toBe(true);
  });

  it('logs in against a Monero JSON-RPC endpoint', async () => {
    const pool = new FakeMoneroPool();
    pools.push(pool);
    await pool.start();
    const { service } = serviceFor(upstream(PoolProtocol.MONERO_JSON_RPC, pool.port));

    await expect(service.test('upstream-id')).resolves.toMatchObject({ ok: true });
    expect(pool.messages[0]).toMatchObject({
      method: 'login',
      params: { login: 'service.health.probe', pass: 'secret' },
    });
  });

  it('records an authentication failure instead of treating an open port as healthy', async () => {
    const pool = new FakeBitcoinPool({ rejectAuthentication: true });
    pools.push(pool);
    await pool.start();
    const { service, update } = serviceFor(upstream(PoolProtocol.BITCOIN_STRATUM_V1, pool.port));

    await expect(service.test('upstream-id')).resolves.toMatchObject({
      ok: false,
      message: 'Bitcoin Stratum authentication failed',
    });
    expect(update.mock.calls[0]?.[0].data.lastHealthOk).toBe(false);
  });
});
