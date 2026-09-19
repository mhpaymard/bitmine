import { AssetCode, DestinationStatus, EntityStatus } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlertsService } from '../../src/alerts/alerts.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { LedgerService } from '../../src/ledger/ledger.service';
import { PublicPortalService } from '../../src/public-portal/public-portal.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { CryptoService } from '../../src/security/crypto.service';
import type { SettingsService } from '../../src/settings/settings.service';
import type { WalletsService } from '../../src/wallets/wallets.service';

afterEach(() => vi.useRealTimers());

function createService(validCredential = true) {
  interface DestinationUpdateInput {
    where: { status: DestinationStatus };
    data: { status: DestinationStatus };
  }
  interface DestinationCreateInput {
    data: {
      status: DestinationStatus;
      minPayoutAtomic: bigint;
      effectiveAt: Date;
      [key: string]: unknown;
    };
  }
  const updateMany = vi
    .fn<(input: DestinationUpdateInput) => Promise<{ count: number }>>()
    .mockResolvedValue({ count: 1 });
  const create = vi
    .fn<(input: DestinationCreateInput) => Promise<Record<string, unknown>>>()
    .mockImplementation(({ data }) => Promise.resolve({ id: 'destination-id', ...data }));
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    payoutDestination: { updateMany, create },
  };
  const prisma = {
    customer: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'customer-id',
        slug: 'customer',
        status: EntityStatus.ACTIVE,
        portalCredential: {
          tokenHash: 'stored-hash',
          revokedAt: null,
        },
      }),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const alertRaise = vi.fn().mockResolvedValue(undefined);
  const walletValidate = vi.fn().mockResolvedValue(true);
  const service = new PublicPortalService(
    prisma,
    {
      verifySecret: vi.fn().mockResolvedValue(validCredential),
      sha256: vi.fn().mockReturnValue('ip-hash'),
    } as unknown as CryptoService,
    {
      connect: vi.fn().mockResolvedValue(undefined),
      client: {
        incr: vi.fn().mockResolvedValue(1),
        expire: vi.fn().mockResolvedValue(1),
      },
    } as unknown as RedisService,
    {} as LedgerService,
    {
      payoutPolicy: vi.fn().mockResolvedValue({
        minimumAtomic: { BTC: '50000', XMR: '10000000000' },
      }),
    } as unknown as SettingsService,
    {
      forAsset: vi.fn().mockReturnValue({ validateAddress: walletValidate }),
    } as unknown as WalletsService,
    { record: auditRecord } as unknown as AuditService,
    { raise: alertRaise } as unknown as AlertsService,
  );
  return { service, updateMany, create, auditRecord, alertRaise, walletValidate };
}

describe('PublicPortalService payout destination safety', () => {
  it('requires valid portal credentials before accepting a wallet request', async () => {
    const { service, walletValidate } = createService(false);

    await expect(
      service.requestDestination(
        {
          customerSlug: 'customer',
          accessCode: 'invalid-access-code-that-is-long-enough',
          asset: AssetCode.BTC,
          address: 'valid-bitcoin-address',
        },
        '127.0.0.1',
      ),
    ).rejects.toThrow(/Invalid portal credentials/u);
    expect(walletValidate).not.toHaveBeenCalled();
  });

  it('replaces an older pending request and enforces a 24-hour cooldown and global minimum', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T10:00:00.000Z'));
    const { service, updateMany, create, auditRecord, alertRaise } = createService();

    const result = await service.requestDestination(
      {
        customerSlug: 'customer',
        accessCode: 'valid-access-code-that-is-long-enough',
        asset: AssetCode.BTC,
        address: 'bc1q1234567890abcdefghijklmnopqrstuv',
        minPayoutAtomic: '1',
      },
      '127.0.0.1',
    );

    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: { status: DestinationStatus.PENDING },
      data: { status: DestinationStatus.REVOKED },
    });
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      status: DestinationStatus.PENDING,
      minPayoutAtomic: 50_000n,
      effectiveAt: new Date('2026-09-18T10:00:00.000Z'),
    });
    expect(result).toMatchObject({
      status: DestinationStatus.PENDING,
      minPayoutAtomic: '50000',
      effectiveAt: new Date('2026-09-18T10:00:00.000Z'),
    });
    expect(result.address).not.toContain('1234567890abcdefghijkl');
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(
      'valid-access-code-that-is-long-enough',
    );
    expect(alertRaise).toHaveBeenCalledOnce();
  });
});
