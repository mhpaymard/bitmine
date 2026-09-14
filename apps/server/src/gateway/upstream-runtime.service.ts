import { Injectable } from '@nestjs/common';
import { AlertSeverity, type AssetCode, type Upstream } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../database/prisma.service';
import { UpstreamsService } from '../upstreams/upstreams.service';

@Injectable()
export class UpstreamRuntimeService {
  private readonly unhealthyUntil = new Map<string, number>();

  constructor(
    private readonly upstreams: UpstreamsService,
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  async candidates(asset: AssetCode): Promise<Upstream[]> {
    const now = Date.now();
    const all = await this.upstreams.candidates(asset);
    return all.sort((a, b) => {
      const aDown = (this.unhealthyUntil.get(a.id) ?? 0) > now ? 1 : 0;
      const bDown = (this.unhealthyUntil.get(b.id) ?? 0) > now ? 1 : 0;
      return aDown - bDown || a.priority - b.priority;
    });
  }

  async success(upstream: Upstream): Promise<void> {
    this.unhealthyUntil.delete(upstream.id);
    await this.prisma.upstream.update({
      where: { id: upstream.id },
      data: {
        lastHealthAt: new Date(),
        lastHealthOk: true,
        lastHealthMessage: 'Gateway connection successful',
      },
    });
    await this.alerts.resolveByDedupe(`upstream:${upstream.id}`);
  }

  async failure(upstream: Upstream, error: unknown): Promise<void> {
    this.unhealthyUntil.set(upstream.id, Date.now() + upstream.failbackCooldownSeconds * 1000);
    await this.prisma.upstream
      .update({
        where: { id: upstream.id },
        data: {
          lastHealthAt: new Date(),
          lastHealthOk: false,
          lastHealthMessage:
            error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        },
      })
      .catch(() => undefined);
    await this.alerts.raise({
      dedupeKey: `upstream:${upstream.id}`,
      severity: AlertSeverity.WARNING,
      title: `${upstream.asset} upstream unavailable`,
      message: `${upstream.name}: ${error instanceof Error ? error.message : String(error)}`,
      metadata: { upstreamId: upstream.id, cooldownSeconds: upstream.failbackCooldownSeconds },
    });
  }
}
