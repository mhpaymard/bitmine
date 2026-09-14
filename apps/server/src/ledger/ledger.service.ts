import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AssetCode,
  DepositStatus,
  JournalType,
  LedgerAccountType,
  LedgerDirection,
  ShareStatus,
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import Decimal from 'decimal.js';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { largestRemainder, splitBasisPoints } from './allocation';

interface EntryInput {
  accountId: string;
  direction: LedgerDirection;
  amountAtomic: bigint;
}

@Injectable()
export class LedgerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async ensureSystemAccounts(asset: AssetCode, tx: Prisma.TransactionClient = this.prisma) {
    const definitions = [
      { code: 'treasury', name: `${asset} treasury`, type: LedgerAccountType.ASSET },
      {
        code: 'allocation-clearing',
        name: `${asset} allocation clearing`,
        type: LedgerAccountType.CLEARING,
      },
      {
        code: 'operator-revenue',
        name: `${asset} operator revenue`,
        type: LedgerAccountType.REVENUE,
      },
      { code: 'network-fee', name: `${asset} network fee`, type: LedgerAccountType.EXPENSE },
      {
        code: 'network-fee-recovery',
        name: `${asset} network fee recovery`,
        type: LedgerAccountType.REVENUE,
      },
    ];
    const result = new Map<string, string>();
    for (const definition of definitions) {
      const account = await tx.ledgerAccount.upsert({
        where: { asset_code: { asset, code: definition.code } },
        create: { asset, ...definition },
        update: { name: definition.name, type: definition.type },
      });
      result.set(definition.code, account.id);
    }
    return result;
  }

  private async post(
    tx: Prisma.TransactionClient,
    input: {
      asset: AssetCode;
      type: JournalType;
      referenceType: string;
      referenceId: string;
      description: string;
      metadata?: Prisma.InputJsonValue;
      entries: EntryInput[];
    },
  ) {
    const debit = input.entries
      .filter((entry) => entry.direction === LedgerDirection.DEBIT)
      .reduce((sum, entry) => sum + entry.amountAtomic, 0n);
    const credit = input.entries
      .filter((entry) => entry.direction === LedgerDirection.CREDIT)
      .reduce((sum, entry) => sum + entry.amountAtomic, 0n);
    if (debit !== credit || debit <= 0n)
      throw new Error(`Unbalanced journal: debit=${debit} credit=${credit}`);
    return tx.journalTransaction.create({
      data: {
        asset: input.asset,
        type: input.type,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        description: input.description,
        metadata: input.metadata,
        entries: { create: input.entries },
      },
      include: { entries: true },
    });
  }

  async allocateDeposit(depositId: string) {
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${depositId}))`;
        const deposit = await tx.deposit.findUnique({ where: { id: depositId } });
        if (!deposit) throw new NotFoundException('Deposit not found');
        if (deposit.status === DepositStatus.ALLOCATED) {
          const existing = await tx.allocationBatch.findUnique({ where: { depositId } });
          if (!existing) throw new ConflictException('Deposit state is inconsistent');
          return existing;
        }
        if (deposit.status !== DepositStatus.CONFIRMED)
          throw new ConflictException('Deposit is not confirmed');
        const depositUpstream = await tx.upstream.findUniqueOrThrow({
          where: { id: deposit.upstreamId },
        });
        const accountEndpoints = await tx.upstream.findMany({
          where: { asset: deposit.asset, accountKey: depositUpstream.accountKey },
          select: { id: true },
        });
        const endpointIds = accountEndpoints.map((endpoint) => endpoint.id);
        const grouped = await tx.shareEvent.groupBy({
          by: ['customerId', 'splitPolicyId'],
          where: {
            upstreamId: { in: endpointIds },
            status: ShareStatus.ACCEPTED,
            allocationBatchId: null,
          },
          _sum: { normalizedWork: true },
        });
        const workGroups = grouped
          .map((group) => ({
            customerId: group.customerId,
            splitPolicyId: group.splitPolicyId,
            work: new Decimal(group._sum.normalizedWork?.toString() ?? '0'),
          }))
          .filter((group) => group.work.gt(0));
        if (!workGroups.length)
          throw new ConflictException('No accepted unallocated work for this upstream');
        const policyIds = [...new Set(workGroups.map((group) => group.splitPolicyId))];
        const policies = await tx.splitPolicyVersion.findMany({ where: { id: { in: policyIds } } });
        const policyMap = new Map(policies.map((policy) => [policy.id, policy]));
        const grossAllocations = largestRemainder(
          deposit.amountAtomic,
          workGroups.map((group) => ({ key: group, weight: group.work })),
        );
        const items = grossAllocations.map(({ key, amount }) => {
          const policy = policyMap.get(key.splitPolicyId);
          if (!policy) throw new Error(`Missing split policy ${key.splitPolicyId}`);
          const split = splitBasisPoints(amount, policy.customerBps);
          return {
            customerId: key.customerId,
            splitPolicyId: key.splitPolicyId,
            work: key.work.toFixed(18),
            grossAtomic: amount,
            customerAtomic: split.customer,
            operatorAtomic: split.operator,
          };
        });
        const customerTotal = items.reduce((sum, item) => sum + item.customerAtomic, 0n);
        const operatorTotal = items.reduce((sum, item) => sum + item.operatorAtomic, 0n);
        if (customerTotal + operatorTotal !== deposit.amountAtomic)
          throw new Error('Allocation invariant failed');
        const batch = await tx.allocationBatch.create({
          data: {
            asset: deposit.asset,
            upstreamId: deposit.upstreamId,
            depositId: deposit.id,
            totalAtomic: deposit.amountAtomic,
            customerTotalAtomic: customerTotal,
            operatorTotalAtomic: operatorTotal,
            items: { create: items },
          },
        });
        await tx.shareEvent.updateMany({
          where: {
            upstreamId: { in: endpointIds },
            status: ShareStatus.ACCEPTED,
            allocationBatchId: null,
          },
          data: { allocationBatchId: batch.id },
        });
        const accounts = await this.ensureSystemAccounts(deposit.asset, tx);
        const treasuryId = accounts.get('treasury')!;
        const clearingId = accounts.get('allocation-clearing')!;
        const operatorId = accounts.get('operator-revenue')!;
        await this.post(tx, {
          asset: deposit.asset,
          type: JournalType.DEPOSIT,
          referenceType: 'Deposit',
          referenceId: deposit.id,
          description: `Confirmed upstream deposit ${deposit.txid}`,
          entries: [
            {
              accountId: treasuryId,
              direction: LedgerDirection.DEBIT,
              amountAtomic: deposit.amountAtomic,
            },
            {
              accountId: clearingId,
              direction: LedgerDirection.CREDIT,
              amountAtomic: deposit.amountAtomic,
            },
          ],
        });
        const liabilityEntries: EntryInput[] = [];
        const customerTotals = new Map<string, bigint>();
        for (const item of items) {
          customerTotals.set(
            item.customerId,
            (customerTotals.get(item.customerId) ?? 0n) + item.customerAtomic,
          );
        }
        for (const [customerId, amount] of customerTotals) {
          if (amount <= 0n) continue;
          const account = await tx.ledgerAccount.upsert({
            where: {
              asset_code: { asset: deposit.asset, code: `customer:${customerId}:liability` },
            },
            create: {
              asset: deposit.asset,
              customerId,
              code: `customer:${customerId}:liability`,
              name: `Customer ${customerId} liability`,
              type: LedgerAccountType.LIABILITY,
            },
            update: {},
          });
          liabilityEntries.push({
            accountId: account.id,
            direction: LedgerDirection.CREDIT,
            amountAtomic: amount,
          });
        }
        await this.post(tx, {
          asset: deposit.asset,
          type: JournalType.ALLOCATION,
          referenceType: 'AllocationBatch',
          referenceId: batch.id,
          description: `Allocate deposit ${deposit.txid}`,
          entries: [
            {
              accountId: clearingId,
              direction: LedgerDirection.DEBIT,
              amountAtomic: deposit.amountAtomic,
            },
            ...liabilityEntries,
            ...(operatorTotal > 0n
              ? [
                  {
                    accountId: operatorId,
                    direction: LedgerDirection.CREDIT,
                    amountAtomic: operatorTotal,
                  },
                ]
              : []),
          ],
        });
        await tx.deposit.update({
          where: { id: deposit.id },
          data: { status: DepositStatus.ALLOCATED, allocatedAt: new Date() },
        });
        return batch;
      },
      { isolationLevel: 'Serializable', timeout: 30_000 },
    );
    this.events.publish('deposit.allocated', { id: depositId, allocationBatchId: result.id });
    return result;
  }

  async customerBalance(
    customerId: string,
    asset: AssetCode,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<bigint> {
    const totals = await tx.journalEntry.groupBy({
      by: ['direction'],
      where: {
        account: { asset, code: `customer:${customerId}:liability` },
      },
      _sum: { amountAtomic: true },
    });
    return totals.reduce(
      (balance, total) =>
        balance +
        (total.direction === LedgerDirection.CREDIT
          ? (total._sum.amountAtomic ?? 0n)
          : -(total._sum.amountAtomic ?? 0n)),
      0n,
    );
  }

  async operatorBalance(
    asset: AssetCode,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<bigint> {
    const totals = await tx.journalEntry.groupBy({
      by: ['direction'],
      where: { account: { asset, code: 'operator-revenue' } },
      _sum: { amountAtomic: true },
    });
    return totals.reduce(
      (balance, total) =>
        balance +
        (total.direction === LedgerDirection.CREDIT
          ? (total._sum.amountAtomic ?? 0n)
          : -(total._sum.amountAtomic ?? 0n)),
      0n,
    );
  }

  async postPayout(
    tx: Prisma.TransactionClient,
    input: {
      batchId: string;
      asset: AssetCode;
      customerId: string;
      grossAtomic: bigint;
      feeAtomic: bigint;
    },
  ) {
    const accounts = await this.ensureSystemAccounts(input.asset, tx);
    const liability = await tx.ledgerAccount.findUniqueOrThrow({
      where: { asset_code: { asset: input.asset, code: `customer:${input.customerId}:liability` } },
    });
    return this.post(tx, {
      asset: input.asset,
      type: JournalType.PAYOUT,
      referenceType: 'PayoutItem',
      referenceId: `${input.batchId}:${input.customerId}`,
      description: `Customer payout from batch ${input.batchId}`,
      entries: [
        {
          accountId: liability.id,
          direction: LedgerDirection.DEBIT,
          amountAtomic: input.grossAtomic,
        },
        {
          accountId: accounts.get('treasury')!,
          direction: LedgerDirection.CREDIT,
          amountAtomic: input.grossAtomic,
        },
        ...(input.feeAtomic > 0n
          ? [
              {
                accountId: accounts.get('network-fee')!,
                direction: LedgerDirection.DEBIT,
                amountAtomic: input.feeAtomic,
              },
              {
                accountId: accounts.get('network-fee-recovery')!,
                direction: LedgerDirection.CREDIT,
                amountAtomic: input.feeAtomic,
              },
            ]
          : []),
      ],
    });
  }

  async postOperatorPayout(
    tx: Prisma.TransactionClient,
    input: { batchId: string; asset: AssetCode; grossAtomic: bigint; feeAtomic: bigint },
  ) {
    const accounts = await this.ensureSystemAccounts(input.asset, tx);
    return this.post(tx, {
      asset: input.asset,
      type: JournalType.PAYOUT,
      referenceType: 'OperatorPayout',
      referenceId: input.batchId,
      description: `Operator revenue payout from batch ${input.batchId}`,
      entries: [
        {
          accountId: accounts.get('operator-revenue')!,
          direction: LedgerDirection.DEBIT,
          amountAtomic: input.grossAtomic,
        },
        {
          accountId: accounts.get('treasury')!,
          direction: LedgerDirection.CREDIT,
          amountAtomic: input.grossAtomic,
        },
        ...(input.feeAtomic > 0n
          ? [
              {
                accountId: accounts.get('network-fee')!,
                direction: LedgerDirection.DEBIT,
                amountAtomic: input.feeAtomic,
              },
              {
                accountId: accounts.get('network-fee-recovery')!,
                direction: LedgerDirection.CREDIT,
                amountAtomic: input.feeAtomic,
              },
            ]
          : []),
      ],
    });
  }

  listTransactions(asset?: AssetCode, take = 100) {
    return this.prisma.journalTransaction.findMany({
      where: asset ? { asset } : undefined,
      take: Math.min(Math.max(take, 1), 500),
      orderBy: { occurredAt: 'desc' },
      include: { entries: { include: { account: true } } },
    });
  }

  async trialBalance(asset: AssetCode) {
    const [accounts, totals] = await Promise.all([
      this.prisma.ledgerAccount.findMany({ where: { asset } }),
      this.prisma.journalEntry.groupBy({
        by: ['accountId', 'direction'],
        where: { account: { asset } },
        _sum: { amountAtomic: true },
      }),
    ]);
    return accounts.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      debitAtomic:
        totals.find(
          (total) => total.accountId === account.id && total.direction === LedgerDirection.DEBIT,
        )?._sum.amountAtomic ?? 0n,
      creditAtomic:
        totals.find(
          (total) => total.accountId === account.id && total.direction === LedgerDirection.CREDIT,
        )?._sum.amountAtomic ?? 0n,
    }));
  }
}
