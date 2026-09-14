import { Injectable } from '@nestjs/common';
import { AlertSeverity, AssetCode, ShareStatus } from '@prisma/client';
import Decimal from 'decimal.js';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { resolvedShares } from '../health/metrics.controller';
import type { AuthorizedWorker } from './gateway.types';
import type { ShareReference } from './gateway.types';
import { BitcoinPoolAdapter, MoneroPoolAdapter } from './pool-adapters';

@Injectable()
export class ShareJournalService {
  private readonly bitcoin = new BitcoinPoolAdapter();
  private readonly monero = new MoneroPoolAdapter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly alerts: AlertsService,
  ) {}

  async createConnection(
    auth: AuthorizedWorker,
    upstreamId: string,
    remoteIp: string,
    clientAgent?: string,
  ) {
    return this.prisma.connectionSession.create({
      data: {
        workerId: auth.worker.id,
        upstreamId,
        asset: auth.worker.asset,
        remoteIp,
        clientAgent,
      },
    });
  }

  async closeConnection(id: string, code: string): Promise<void> {
    await this.prisma.connectionSession.updateMany({
      where: { id, disconnectedAt: null },
      data: { disconnectedAt: new Date(), disconnectCode: code.slice(0, 80) },
    });
  }

  async activePolicy(customerId: string, asset: AssetCode) {
    return this.prisma.splitPolicyVersion.findFirstOrThrow({
      where: { customerId, asset, effectiveAt: { lte: new Date() } },
      orderBy: { effectiveAt: 'desc' },
    });
  }

  async pending(input: {
    auth: AuthorizedWorker;
    upstreamId: string;
    connectionId: string;
    requestKey: string;
    difficulty: string;
  }): Promise<ShareReference> {
    const policy = await this.activePolicy(input.auth.customer.id, input.auth.worker.asset);
    const work =
      input.auth.worker.asset === AssetCode.BTC
        ? this.bitcoin.normalizedWork(input.difficulty)
        : this.monero.normalizedWork(input.difficulty);
    const share = await this.prisma.shareEvent.create({
      data: {
        asset: input.auth.worker.asset,
        customerId: input.auth.customer.id,
        workerId: input.auth.worker.id,
        upstreamId: input.upstreamId,
        connectionId: input.connectionId,
        splitPolicyId: policy.id,
        requestKey: input.requestKey,
        difficulty: new Decimal(input.difficulty).toFixed(18),
        normalizedWork: work,
      },
    });
    return { id: share.id, submittedAt: share.submittedAt };
  }

  async resolve(
    reference: ShareReference,
    accepted: boolean,
    latencyMs: number,
    reason?: string,
  ): Promise<void> {
    const status = accepted ? ShareStatus.ACCEPTED : ShareStatus.REJECTED;
    const share = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.shareEvent.update({
        where: { id_submittedAt: reference },
        data: {
          status,
          resolvedAt: new Date(),
          upstreamLatencyMs: latencyMs,
          rejectReason: reason?.slice(0, 1000),
        },
      });
      await tx.connectionSession.update({
        where: { id: updated.connectionId },
        data: accepted ? { acceptedCount: { increment: 1 } } : { rejectedCount: { increment: 1 } },
      });
      return updated;
    });
    this.events.publish('share.resolved', {
      id: share.id,
      workerId: share.workerId,
      asset: share.asset,
      status,
      difficulty: share.difficulty.toString(),
      at: share.resolvedAt?.toISOString(),
    });
    resolvedShares.inc({ asset: share.asset, status });
  }

  async unknown(references: ShareReference[], reason: string): Promise<void> {
    if (!references.length) return;
    await this.prisma.$transaction(
      references.map((reference) =>
        this.prisma.shareEvent.updateMany({
          where: { ...reference, status: ShareStatus.PENDING },
          data: {
            status: ShareStatus.UNKNOWN,
            resolvedAt: new Date(),
            rejectReason: reason.slice(0, 1000),
          },
        }),
      ),
    );
    await this.alerts.raise({
      dedupeKey: 'unknown-shares',
      severity: AlertSeverity.WARNING,
      title: 'Shares require reconciliation',
      message: `${references.length} share responses became UNKNOWN: ${reason}`,
      metadata: { count: references.length, reason },
    });
  }
}
