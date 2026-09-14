import { AssetCode, EntityStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { CryptoService } from '../../src/security/crypto.service';
import { GatewayAuthService } from '../../src/gateway/gateway-auth.service';

function fixture(acquired: number) {
  const now = new Date();
  const customer = {
    id: 'customer-id',
    slug: 'alice',
    displayName: 'Alice',
    status: EntityStatus.ACTIVE,
    timezone: 'UTC',
    notes: null,
    createdAt: now,
    updatedAt: now,
  };
  const worker = {
    id: 'worker-id',
    customerId: customer.id,
    slug: 'rig01',
    asset: AssetCode.BTC,
    status: EntityStatus.ACTIVE,
    maxConnections: 1,
    allowedIps: ['10.0.0.0/8'],
    lastSeenAt: null,
    createdAt: now,
    updatedAt: now,
    customer,
    credentials: [{ tokenHash: 'hash' }],
  };
  const policy = {
    id: 'policy-id',
    customerId: customer.id,
    asset: AssetCode.BTC,
    customerBps: 8000,
    operatorBps: 2000,
    effectiveAt: now,
    createdById: null,
    createdAt: now,
  };
  const prisma = {
    worker: { findFirst: vi.fn().mockResolvedValue(worker) },
    splitPolicyVersion: { findFirst: vi.fn().mockResolvedValue(policy) },
  } as unknown as PrismaService;
  const client = {
    eval: vi.fn().mockResolvedValue(acquired),
    zrem: vi.fn().mockResolvedValue(1),
    zcard: vi.fn().mockResolvedValue(0),
    del: vi.fn().mockResolvedValue(1),
  };
  const redis = {
    connect: vi.fn().mockResolvedValue(undefined),
    client,
  } as unknown as RedisService;
  const crypto = {
    verifySecret: vi.fn().mockResolvedValue(true),
    randomToken: vi.fn().mockReturnValue('lease-token'),
  } as unknown as CryptoService;
  return { service: new GatewayAuthService(prisma, redis, crypto), client };
}

describe('GatewayAuthService connection leases', () => {
  it('atomically reserves a bounded, expiring lease after credential validation', async () => {
    const { service, client } = fixture(1);
    const result = await service.authenticate(
      AssetCode.BTC,
      'alice.rig01',
      'local-token',
      '10.1.2.3',
    );

    expect(result?.connectionLeaseId).toBe('lease-token');
    expect(client.eval).toHaveBeenCalledOnce();
    expect(String(client.eval.mock.calls[0]?.[0])).toContain('ZREMRANGEBYSCORE');
    expect(String(client.eval.mock.calls[0]?.[0])).toContain('ZCARD');
  });

  it('rejects a connection when the atomic lease limit is full', async () => {
    const { service } = fixture(0);
    await expect(
      service.authenticate(AssetCode.BTC, 'alice.rig01', 'local-token', '10.1.2.3'),
    ).resolves.toBeNull();
  });

  it('releases the exact lease and removes an empty key', async () => {
    const { service, client } = fixture(1);
    await service.connectionClosed('worker-id', 'lease-token');
    expect(client.zrem).toHaveBeenCalledWith('gateway:connections:worker-id', 'lease-token');
    expect(client.del).toHaveBeenCalledWith('gateway:connections:worker-id');
  });
});
