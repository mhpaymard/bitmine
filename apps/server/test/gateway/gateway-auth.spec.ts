import { AssetCode, EntityStatus } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../src/audit/audit.service';
import type { Environment } from '../../src/config/environment';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { CryptoService } from '../../src/security/crypto.service';
import { GatewayAuthService } from '../../src/gateway/gateway-auth.service';

const defaultEnv: Record<string, unknown> = {
  GATEWAY_AUTO_PROVISION_ENABLED: false,
  GATEWAY_AUTO_PROVISION_CUSTOMER_BPS: 8000,
  GATEWAY_AUTO_PROVISION_MAX_CONNECTIONS: 4,
  GATEWAY_AUTO_PROVISION_MAX_PER_IP_PER_HOUR: 20,
};

function configFixture(overrides: Record<string, unknown> = {}) {
  const values = { ...defaultEnv, ...overrides };
  return { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService<
    Environment,
    true
  >;
}

function fixture(acquired: number, envOverrides: Record<string, unknown> = {}) {
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
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  };
  const redis = {
    connect: vi.fn().mockResolvedValue(undefined),
    client,
  } as unknown as RedisService;
  const crypto = {
    verifySecret: vi.fn().mockResolvedValue(true),
    hashSecret: vi.fn().mockResolvedValue('hashed'),
    randomToken: vi.fn().mockReturnValue('lease-token'),
    sha256: vi.fn().mockReturnValue('ip-hash'),
  } as unknown as CryptoService;
  const config = configFixture(envOverrides);
  const auditMock = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new GatewayAuthService(
      prisma,
      redis,
      crypto,
      config,
      auditMock as unknown as AuditService,
    ),
    client,
    prisma,
    audit: auditMock,
  };
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

describe('GatewayAuthService auto-provisioning', () => {
  it('rejects an unknown customer.worker when auto-provisioning is disabled', async () => {
    const { service, prisma } = fixture(1, { GATEWAY_AUTO_PROVISION_ENABLED: false });
    (prisma.worker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      service.authenticate(AssetCode.BTC, 'newcustomer.rig01', 'x', '10.1.2.3'),
    ).resolves.toBeNull();
  });

  it('creates the customer and worker on first connect when enabled', async () => {
    const { service, prisma, audit } = fixture(1, { GATEWAY_AUTO_PROVISION_ENABLED: true });
    (prisma.worker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const now = new Date();
    const createdCustomer = {
      id: 'new-customer-id',
      slug: 'newcustomer',
      displayName: 'newcustomer',
      status: EntityStatus.ACTIVE,
      timezone: 'UTC',
      notes: null,
      createdAt: now,
      updatedAt: now,
    };
    const createdWorker = {
      id: 'new-worker-id',
      customerId: createdCustomer.id,
      slug: 'rig01',
      asset: AssetCode.BTC,
      status: EntityStatus.ACTIVE,
      maxConnections: 4,
      allowedIps: [],
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
      customer: createdCustomer,
    };
    const tx = {
      customer: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdCustomer),
      },
      splitPolicyVersion: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      ledgerAccount: { createMany: vi.fn().mockResolvedValue({ count: 2 }) },
      worker: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(createdWorker),
      },
    };
    (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction = vi
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) => callback(tx));

    const result = await service.authenticate(AssetCode.BTC, 'newcustomer.rig01', 'x', '10.1.2.3');

    expect(result?.worker.id).toBe('new-worker-id');
    expect(result?.customer.slug).toBe('newcustomer');
    expect(tx.customer.create).toHaveBeenCalledOnce();
    expect(tx.worker.create).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'GATEWAY_AUTO_PROVISIONED' }),
    );
  });

  it('rate-limits auto-provisioning attempts per source IP', async () => {
    const { service, prisma, client } = fixture(1, { GATEWAY_AUTO_PROVISION_ENABLED: true });
    (prisma.worker.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    client.incr.mockResolvedValue(999);

    await expect(
      service.authenticate(AssetCode.BTC, 'newcustomer.rig01', 'x', '10.1.2.3'),
    ).resolves.toBeNull();
  });
});
