import { AssetCode } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AlertsService } from '../../src/alerts/alerts.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { EventsService } from '../../src/events/events.service';
import type { LedgerService } from '../../src/ledger/ledger.service';
import { DepositsService } from '../../src/wallets/deposits.service';
import type { WalletsService } from '../../src/wallets/wallets.service';

describe('deposit account attribution', () => {
  it('rejects an address shared by different pool accounts', async () => {
    const prisma = {
      upstream: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'endpoint-a',
            accountKey: 'account-a',
            receiveAddress: 'wallet-address',
            priority: 1,
          },
          {
            id: 'endpoint-b',
            accountKey: 'account-b',
            receiveAddress: 'wallet-address',
            priority: 2,
          },
        ]),
      },
    } as unknown as PrismaService;
    const forAsset = vi.fn();
    const wallets = { forAsset } as unknown as WalletsService;
    const service = new DepositsService(
      prisma,
      wallets,
      {} as LedgerService,
      {} as AlertsService,
      {} as EventsService,
    );

    await expect(service.scanAsset(AssetCode.BTC)).rejects.toThrow(/multiple pool accounts/u);
    expect(forAsset).not.toHaveBeenCalled();
  });

  it('uses one canonical endpoint when failovers share an account and address', async () => {
    const prisma = {
      upstream: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'secondary',
            accountKey: 'account-a',
            receiveAddress: 'wallet-address',
            priority: 20,
          },
          {
            id: 'primary',
            accountKey: 'account-a',
            receiveAddress: 'wallet-address',
            priority: 10,
          },
        ]),
      },
      deposit: { findUnique: vi.fn(), upsert: vi.fn() },
    } as unknown as PrismaService;
    const scanReceipts = vi.fn().mockResolvedValue([]);
    const wallets = {
      forAsset: vi.fn().mockReturnValue({ scanReceipts }),
    } as unknown as WalletsService;
    const alerts = { resolveByDedupe: vi.fn() } as unknown as AlertsService;
    const service = new DepositsService(
      prisma,
      wallets,
      {} as LedgerService,
      alerts,
      {} as EventsService,
    );

    await expect(service.scanAsset(AssetCode.BTC)).resolves.toBe(0);
    expect(scanReceipts).toHaveBeenCalledWith(['wallet-address']);
  });
});
