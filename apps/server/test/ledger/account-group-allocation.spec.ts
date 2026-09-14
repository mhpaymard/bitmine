import { AssetCode, DepositStatus, ShareStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/database/prisma.service';
import type { EventsService } from '../../src/events/events.service';
import { LedgerService } from '../../src/ledger/ledger.service';

describe('pool-account deposit allocation', () => {
  it('allocates accepted work from every failover endpoint in the account', async () => {
    interface ShareQuery {
      where: {
        upstreamId: { in: string[] };
        status?: ShareStatus;
      };
    }
    const groupBy = vi
      .fn<(input: ShareQuery) => Promise<unknown[]>>()
      .mockResolvedValue([
        { customerId: 'customer-id', splitPolicyId: 'policy-id', _sum: { normalizedWork: '10' } },
      ]);
    const updateMany = vi
      .fn<(input: ShareQuery) => Promise<{ count: number }>>()
      .mockResolvedValue({ count: 2 });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      deposit: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'deposit-id',
          asset: AssetCode.BTC,
          upstreamId: 'primary-id',
          status: DepositStatus.CONFIRMED,
          amountAtomic: 1000n,
          txid: 'txid',
        }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      upstream: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ accountKey: 'viabtc-main' }),
        findMany: vi.fn().mockResolvedValue([{ id: 'primary-id' }, { id: 'secondary-id' }]),
      },
      shareEvent: { groupBy, updateMany },
      splitPolicyVersion: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'policy-id', customerBps: 8000, operatorBps: 2000 }]),
      },
      allocationBatch: {
        create: vi.fn().mockResolvedValue({ id: 'allocation-id' }),
      },
      ledgerAccount: {
        upsert: vi
          .fn()
          .mockImplementation(({ where }: { where: { asset_code: { code: string } } }) =>
            Promise.resolve({ id: `account:${where.asset_code.code}` }),
          ),
      },
      journalTransaction: {
        create: vi.fn().mockResolvedValue({ id: 'journal-id', entries: [] }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const events = { publish: vi.fn() } as unknown as EventsService;
    const ledger = new LedgerService(prisma, events);

    await ledger.allocateDeposit('deposit-id');

    expect(groupBy.mock.calls[0]?.[0].where).toMatchObject({
      upstreamId: { in: ['primary-id', 'secondary-id'] },
      status: ShareStatus.ACCEPTED,
    });
    expect(updateMany.mock.calls[0]?.[0].where.upstreamId).toEqual({
      in: ['primary-id', 'secondary-id'],
    });
  });
});
