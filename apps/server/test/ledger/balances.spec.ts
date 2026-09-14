import { AssetCode, LedgerAccountType, LedgerDirection } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/database/prisma.service';
import type { EventsService } from '../../src/events/events.service';
import { LedgerService } from '../../src/ledger/ledger.service';

const events = { publish: vi.fn() } as unknown as EventsService;

describe('ledger balances', () => {
  it('calculates a customer balance from aggregated credits and debits', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { direction: LedgerDirection.CREDIT, _sum: { amountAtomic: 1_000n } },
      { direction: LedgerDirection.DEBIT, _sum: { amountAtomic: 300n } },
    ]);
    const tx = { journalEntry: { groupBy } };
    const ledger = new LedgerService({} as PrismaService, events);

    await expect(ledger.customerBalance('customer-id', AssetCode.BTC, tx as never)).resolves.toBe(
      700n,
    );
    expect(groupBy).toHaveBeenCalledWith({
      by: ['direction'],
      where: {
        account: { asset: AssetCode.BTC, code: 'customer:customer-id:liability' },
      },
      _sum: { amountAtomic: true },
    });
  });

  it('calculates the operator balance entirely in the database', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { direction: LedgerDirection.CREDIT, _sum: { amountAtomic: 900n } },
      { direction: LedgerDirection.DEBIT, _sum: { amountAtomic: 125n } },
    ]);
    const tx = { journalEntry: { groupBy } };
    const ledger = new LedgerService({} as PrismaService, events);

    await expect(ledger.operatorBalance(AssetCode.XMR, tx as never)).resolves.toBe(775n);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['direction'],
      where: { account: { asset: AssetCode.XMR, code: 'operator-revenue' } },
      _sum: { amountAtomic: true },
    });
  });

  it('returns debit and credit totals for every ledger account', async () => {
    const prisma = {
      ledgerAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'treasury-id',
            code: 'treasury',
            name: 'BTC treasury',
            type: LedgerAccountType.ASSET,
          },
          {
            id: 'revenue-id',
            code: 'operator-revenue',
            name: 'BTC operator revenue',
            type: LedgerAccountType.REVENUE,
          },
        ]),
      },
      journalEntry: {
        groupBy: vi.fn().mockResolvedValue([
          {
            accountId: 'treasury-id',
            direction: LedgerDirection.DEBIT,
            _sum: { amountAtomic: 2_000n },
          },
          {
            accountId: 'treasury-id',
            direction: LedgerDirection.CREDIT,
            _sum: { amountAtomic: 450n },
          },
          {
            accountId: 'revenue-id',
            direction: LedgerDirection.CREDIT,
            _sum: { amountAtomic: 300n },
          },
        ]),
      },
    } as unknown as PrismaService;
    const ledger = new LedgerService(prisma, events);

    await expect(ledger.trialBalance(AssetCode.BTC)).resolves.toEqual([
      {
        id: 'treasury-id',
        code: 'treasury',
        name: 'BTC treasury',
        type: LedgerAccountType.ASSET,
        debitAtomic: 2_000n,
        creditAtomic: 450n,
      },
      {
        id: 'revenue-id',
        code: 'operator-revenue',
        name: 'BTC operator revenue',
        type: LedgerAccountType.REVENUE,
        debitAtomic: 0n,
        creditAtomic: 300n,
      },
    ]);
  });
});
