import type { ConfigService } from '@nestjs/config';
import { AssetCode } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertsService } from '../../src/alerts/alerts.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { AuthenticatedAdmin } from '../../src/auth/auth.types';
import type { Environment } from '../../src/config/environment';
import { CustomersService } from '../../src/customers/customers.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { CryptoService } from '../../src/security/crypto.service';
import type { WalletsService } from '../../src/wallets/wallets.service';

const actor = { id: 'admin-id' } as AuthenticatedAdmin;

afterEach(() => vi.useRealTimers());

function serviceWith(prisma: object, overrides: Record<string, unknown> = {}) {
  const crypto = {
    randomToken: vi.fn().mockReturnValue('raw-worker-token-that-is-only-shown-once'),
    hashSecret: vi.fn().mockResolvedValue('argon2-token-hash'),
    ...(overrides.crypto as object),
  } as unknown as CryptoService;
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const audit = {
    record: auditRecord,
    ...(overrides.audit as object),
  } as unknown as AuditService;
  const config = {
    get: vi
      .fn()
      .mockImplementation((key: string) =>
        key === 'BITCOIN_MIN_PAYOUT_ATOMIC' ? 50_000n : 10_000_000_000n,
      ),
  } as unknown as ConfigService<Environment, true>;
  const wallets = {
    forAsset: vi.fn().mockReturnValue({ validateAddress: vi.fn().mockResolvedValue(true) }),
    ...(overrides.wallets as object),
  } as unknown as WalletsService;
  const alertRaise = vi.fn().mockResolvedValue(undefined);
  const alerts = {
    raise: alertRaise,
    resolveByDedupe: vi.fn().mockResolvedValue(undefined),
  } as unknown as AlertsService;
  return {
    service: new CustomersService(prisma as PrismaService, crypto, audit, config, wallets, alerts),
    crypto,
    audit,
    auditRecord,
    wallets,
    alerts,
    alertRaise,
  };
}

describe('CustomersService secrets and payout safety', () => {
  it('selects credential metadata without ever selecting token hashes', async () => {
    interface CustomerQuery {
      include: {
        workers: { include: { credentials: { select: Record<string, boolean> } } };
      };
    }
    const findUnique = vi
      .fn<(input: CustomerQuery) => Promise<{ id: string; workers: never[] }>>()
      .mockResolvedValue({ id: 'customer-id', workers: [] });
    const { service } = serviceWith({ customer: { findUnique } });

    await service.get('customer-id');

    const query = findUnique.mock.calls[0]?.[0];
    expect(query).toBeDefined();
    if (!query) throw new Error('Customer query was not captured');
    expect(query.include.workers.include.credentials.select).toEqual(
      expect.objectContaining({ id: true, tokenPrefix: true }),
    );
    expect(query.include.workers.include.credentials.select).not.toHaveProperty('tokenHash');
  });

  it('stores only a credential hash and returns the raw token exactly at creation', async () => {
    interface WorkerCreateInput {
      data: { credentials: { create: { tokenHash: string; tokenPrefix: string } } };
    }
    const create = vi
      .fn<
        (input: WorkerCreateInput) => Promise<{
          id: string;
          slug: string;
          customer: { slug: string };
        }>
      >()
      .mockResolvedValue({
        id: 'worker-id',
        slug: 'rig-1',
        customer: { slug: 'customer' },
      });
    const prisma = {
      customer: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'customer-id' }) },
      worker: { create },
    };
    const { service, auditRecord } = serviceWith(prisma);

    const result = await service.createWorker(
      'customer-id',
      { slug: 'rig-1', asset: AssetCode.BTC },
      actor,
    );

    expect(result.credentials).toEqual({
      username: 'customer.rig-1',
      password: 'raw-worker-token-that-is-only-shown-once',
      shownOnce: true,
    });
    expect(create.mock.calls[0]?.[0].data.credentials.create).toMatchObject({
      tokenHash: 'argon2-token-hash',
      tokenPrefix: 'raw-worker',
    });
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(
      'raw-worker-token-that-is-only-shown-once',
    );
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain('argon2-token-hash');
  });

  it('rejects malformed worker allowlist entries before storing a credential', async () => {
    const { service } = serviceWith({
      customer: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'customer-id' }) },
    });

    await expect(
      service.createWorker(
        'customer-id',
        { slug: 'rig-1', asset: AssetCode.BTC, allowedIps: ['10.0.0.0/99'] },
        actor,
      ),
    ).rejects.toThrow(/Invalid worker IP rule/u);
  });

  it('validates and cools a payout destination for exactly 24 hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
    const destinationCreate = vi
      .fn()
      .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'destination-id', ...data }),
      );
    const prisma = {
      customer: { findUnique: vi.fn().mockResolvedValue({ id: 'customer-id' }) },
      payoutDestination: { create: destinationCreate },
    };
    const { service, alertRaise } = serviceWith(prisma);

    const destination = await service.createDestination(
      'customer-id',
      { asset: AssetCode.BTC, address: '  valid-bitcoin-address  ' },
      actor,
    );

    expect(destination).toMatchObject({
      address: 'valid-bitcoin-address',
      minPayoutAtomic: 50_000n,
      effectiveAt: new Date('2026-09-14T12:00:00.000Z'),
    });
    expect(alertRaise).toHaveBeenCalledOnce();
  });
});
