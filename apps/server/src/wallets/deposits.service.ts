import { Injectable, Logger } from '@nestjs/common';
import { AlertSeverity, AssetCode, DepositStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from './wallets.service';

@Injectable()
export class DepositsService {
  private readonly logger = new Logger(DepositsService.name);
  private scanning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallets: WalletsService,
    private readonly ledger: LedgerService,
    private readonly alerts: AlertsService,
    private readonly events: EventsService,
  ) {}

  async scanAll(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const asset of [AssetCode.BTC, AssetCode.XMR]) {
        await this.scanAsset(asset).catch(async (error: unknown) => {
          await this.alerts.raise({
            dedupeKey: `wallet-scan:${asset}`,
            severity: AlertSeverity.CRITICAL,
            title: `${asset} wallet scan failed`,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } finally {
      this.scanning = false;
    }
  }

  async scanAsset(asset: AssetCode): Promise<number> {
    const upstreams = await this.prisma.upstream.findMany({
      where: { asset, enabled: true, receiveAddress: { not: null } },
    });
    const byAddress = new Map<string, (typeof upstreams)[number]>();
    for (const upstream of upstreams) {
      if (!upstream.receiveAddress) continue;
      const existing = byAddress.get(upstream.receiveAddress);
      if (existing && existing.accountKey !== upstream.accountKey) {
        throw new Error(
          `Receive address ${upstream.receiveAddress} is assigned to multiple pool accounts`,
        );
      }
      if (!existing || upstream.priority < existing.priority)
        byAddress.set(upstream.receiveAddress, upstream);
    }
    const receipts = await this.wallets.forAsset(asset).scanReceipts([...byAddress.keys()]);
    await this.alerts.resolveByDedupe(`wallet-scan:${asset}`);
    for (const receipt of receipts) {
      const upstream = byAddress.get(receipt.address);
      if (!upstream) continue;
      const status = receipt.locked ? DepositStatus.OBSERVED : DepositStatus.CONFIRMED;
      const existing = await this.prisma.deposit.findUnique({
        where: {
          asset_txid_outputRef: { asset, txid: receipt.txid, outputRef: receipt.outputRef },
        },
      });
      if (existing?.status === DepositStatus.ALLOCATED && receipt.locked) {
        await this.prisma.deposit.update({
          where: { id: existing.id },
          data: {
            status: DepositStatus.REORGED,
            confirmations: receipt.confirmations,
            locked: true,
          },
        });
        await this.alerts.raise({
          dedupeKey: `deposit-reorg:${existing.id}`,
          severity: AlertSeverity.CRITICAL,
          title: `${asset} allocated deposit reorged`,
          message: `Deposit ${receipt.txid} lost required confirmations. Automatic payouts must be reviewed.`,
          metadata: { depositId: existing.id, txid: receipt.txid },
        });
        continue;
      }
      const deposit = await this.prisma.deposit.upsert({
        where: {
          asset_txid_outputRef: { asset, txid: receipt.txid, outputRef: receipt.outputRef },
        },
        create: {
          asset,
          upstreamId: upstream.id,
          txid: receipt.txid,
          outputRef: receipt.outputRef,
          amountAtomic: receipt.amountAtomic,
          confirmations: receipt.confirmations,
          locked: receipt.locked,
          status,
          confirmedAt: status === DepositStatus.CONFIRMED ? new Date() : null,
          raw: receipt.raw as Prisma.InputJsonValue,
        },
        update: {
          confirmations: receipt.confirmations,
          locked: receipt.locked,
          status: existing?.status === DepositStatus.ALLOCATED ? DepositStatus.ALLOCATED : status,
          confirmedAt:
            status === DepositStatus.CONFIRMED
              ? (existing?.confirmedAt ?? new Date())
              : existing?.confirmedAt,
          raw: receipt.raw as Prisma.InputJsonValue,
        },
      });
      this.events.publish('deposit.observed', {
        id: deposit.id,
        asset,
        amountAtomic: deposit.amountAtomic.toString(),
        status: deposit.status,
      });
      if (deposit.status === DepositStatus.CONFIRMED) {
        await this.ledger.allocateDeposit(deposit.id).catch((error: unknown) => {
          this.logger.warn(
            `Deposit ${deposit.id} is confirmed but not allocated: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
    return receipts.length;
  }

  list(asset?: AssetCode) {
    return this.prisma.deposit.findMany({
      where: asset ? { asset } : undefined,
      orderBy: { observedAt: 'desc' },
      include: { upstream: { select: { id: true, name: true } }, allocationBatch: true },
      take: 500,
    });
  }
}
