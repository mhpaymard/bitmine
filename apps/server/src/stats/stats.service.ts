import { Injectable } from '@nestjs/common';
import { AssetCode, ShareStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { GatewayService } from '../gateway/gateway.service';

@Injectable()
export class StatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: GatewayService,
  ) {}

  async dashboard() {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [
      customers,
      workers,
      activeConnections,
      accepted,
      rejected,
      openAlerts,
      pendingPayouts,
      recentDeposits,
    ] = await Promise.all([
      this.prisma.customer.count({ where: { status: 'ACTIVE' } }),
      this.prisma.worker.count({ where: { status: 'ACTIVE' } }),
      this.prisma.connectionSession.count({ where: { disconnectedAt: null } }),
      this.prisma.shareEvent.count({
        where: { status: ShareStatus.ACCEPTED, submittedAt: { gte: since } },
      }),
      this.prisma.shareEvent.count({
        where: { status: ShareStatus.REJECTED, submittedAt: { gte: since } },
      }),
      this.prisma.alert.count({ where: { status: 'OPEN' } }),
      this.prisma.payoutBatch.count({
        where: {
          state: { in: ['PLANNED', 'APPROVAL_REQUIRED', 'AUTO_APPROVED', 'SIGNED', 'BROADCAST'] },
        },
      }),
      this.prisma.deposit.findMany({
        orderBy: { observedAt: 'desc' },
        take: 10,
        include: { upstream: { select: { name: true } } },
      }),
    ]);
    return {
      customers,
      workers,
      activeConnections,
      gateway: this.gateway.status(),
      shares24h: {
        accepted,
        rejected,
        acceptanceRate: accepted + rejected > 0 ? accepted / (accepted + rejected) : 1,
      },
      openAlerts,
      pendingPayouts,
      recentDeposits,
    };
  }

  async workers(asset?: AssetCode) {
    const workers = await this.prisma.worker.findMany({
      where: asset ? { asset } : undefined,
      include: {
        customer: { select: { id: true, slug: true, displayName: true } },
        connections: {
          where: { disconnectedAt: null },
          include: { upstream: { select: { name: true } } },
        },
      },
      orderBy: { lastSeenAt: 'desc' },
    });
    const now = Date.now();
    const windows = [1, 5, 15] as const;
    const aggregates = new Map<
      number,
      Map<string, { work: number; accepted: bigint; rejected: bigint }>
    >();
    for (const minutes of windows) {
      const groups = await this.prisma.shareEvent.groupBy({
        by: ['workerId', 'status'],
        where: {
          submittedAt: { gte: new Date(now - minutes * 60_000) },
          status: { in: [ShareStatus.ACCEPTED, ShareStatus.REJECTED] },
          ...(asset ? { asset } : {}),
        },
        _sum: { normalizedWork: true },
        _count: { _all: true },
      });
      const map = new Map<string, { work: number; accepted: bigint; rejected: bigint }>();
      for (const group of groups) {
        const current = map.get(group.workerId) ?? { work: 0, accepted: 0n, rejected: 0n };
        if (group.status === ShareStatus.ACCEPTED) {
          current.work += Number(group._sum.normalizedWork?.toString() ?? '0');
          current.accepted += BigInt(group._count._all);
        } else {
          current.rejected += BigInt(group._count._all);
        }
        map.set(group.workerId, current);
      }
      aggregates.set(minutes, map);
    }
    return workers.map((worker) => {
      const one = aggregates.get(1)?.get(worker.id);
      const five = aggregates.get(5)?.get(worker.id);
      const fifteen = aggregates.get(15)?.get(worker.id);
      return {
        id: worker.id,
        slug: worker.slug,
        asset: worker.asset,
        status: worker.status,
        customer: worker.customer,
        connected: worker.connections.length > 0,
        activeConnections: worker.connections.length,
        upstreamName: worker.connections[0]?.upstream?.name ?? null,
        lastSeenAt: worker.lastSeenAt,
        hashrate1m: (one?.work ?? 0) / 60,
        hashrate5m: (five?.work ?? 0) / 300,
        hashrate15m: (fifteen?.work ?? 0) / 900,
        accepted15m: fifteen?.accepted ?? 0n,
        rejected15m: fifteen?.rejected ?? 0n,
      };
    });
  }
}
