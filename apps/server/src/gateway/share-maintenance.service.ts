import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { AlertSeverity, Prisma, ShareStatus } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class ShareMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(ShareMaintenanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
    private readonly alerts: AlertsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensurePartitions();
  }

  @Cron('0 5 0 * * *', { timeZone: 'UTC' })
  async ensurePartitions(): Promise<void> {
    await this.prisma.$executeRaw`SELECT ensure_share_partitions(60)`;
  }

  @Cron('20 * * * * *')
  async aggregate(): Promise<void> {
    try {
      await this.upsertBuckets('1 minute', 60, new Date(Date.now() - 5 * 60_000));
      await this.upsertBuckets('1 hour', 3600, new Date(Date.now() - 3 * 60 * 60_000));
      await this.upsertBuckets('1 day', 86400, new Date(Date.now() - 3 * 24 * 60 * 60_000));
    } catch (error) {
      this.logger.warn(
        `Share aggregation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron('0 7 * * * *')
  async reconcilePending(): Promise<void> {
    const result = await this.prisma.shareEvent.updateMany({
      where: {
        status: ShareStatus.PENDING,
        submittedAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
      data: {
        status: ShareStatus.UNKNOWN,
        resolvedAt: new Date(),
        rejectReason: 'Gateway response was not recorded',
      },
    });
    if (result.count > 0) {
      await this.alerts.raise({
        dedupeKey: 'stale-pending-shares',
        severity: AlertSeverity.WARNING,
        title: 'Shares require reconciliation',
        message: `${result.count} stale PENDING shares were moved to UNKNOWN`,
        metadata: { count: result.count },
      });
    }
  }

  @Cron('0 20 2 * * *', { timeZone: 'Asia/Tehran' })
  async pruneRawShares(): Promise<void> {
    const days = this.config.get('RAW_SHARE_RETENTION_DAYS', { infer: true });
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
    const result = await this.prisma.shareEvent.deleteMany({
      where: {
        submittedAt: { lt: cutoff },
        OR: [
          { status: ShareStatus.ACCEPTED, allocationBatchId: { not: null } },
          { status: { in: [ShareStatus.REJECTED, ShareStatus.UNKNOWN] } },
        ],
      },
    });
    if (result.count > 0)
      this.logger.log(`Pruned ${result.count} raw share records older than ${days} days`);
  }

  private async upsertBuckets(stride: string, bucketSeconds: number, cutoff: Date): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      WITH grouped AS (
        SELECT
          date_bin(${stride}::interval, "submittedAt", TIMESTAMP '1970-01-01') AS bucket,
          "asset",
          "customerId",
          "workerId",
          COUNT(*) FILTER (WHERE "status" = 'ACCEPTED'::"ShareStatus")::bigint AS accepted_count,
          COUNT(*) FILTER (WHERE "status" = 'REJECTED'::"ShareStatus")::bigint AS rejected_count,
          COALESCE(SUM("normalizedWork") FILTER (WHERE "status" = 'ACCEPTED'::"ShareStatus"), 0) AS accepted_work,
          COALESCE(SUM("normalizedWork") FILTER (WHERE "status" = 'REJECTED'::"ShareStatus"), 0) AS rejected_work,
          AVG("upstreamLatencyMs") FILTER (WHERE "upstreamLatencyMs" IS NOT NULL)::integer AS avg_latency
        FROM "ShareEvent"
        WHERE "submittedAt" >= ${cutoff}
          AND "status" IN ('ACCEPTED'::"ShareStatus", 'REJECTED'::"ShareStatus")
        GROUP BY bucket, "asset", "customerId", "workerId"
      )
      INSERT INTO "ShareAggregate" (
        "id", "bucketStart", "bucketSeconds", "asset", "customerId", "workerId",
        "acceptedCount", "rejectedCount", "acceptedWork", "rejectedWork", "avgLatencyMs"
      )
      SELECT
        gen_random_uuid(), bucket, ${bucketSeconds}, "asset", "customerId", "workerId",
        accepted_count, rejected_count, accepted_work, rejected_work, avg_latency
      FROM grouped
      ON CONFLICT ("bucketStart", "bucketSeconds", "workerId") DO UPDATE SET
        "acceptedCount" = EXCLUDED."acceptedCount",
        "rejectedCount" = EXCLUDED."rejectedCount",
        "acceptedWork" = EXCLUDED."acceptedWork",
        "rejectedWork" = EXCLUDED."rejectedWork",
        "avgLatencyMs" = EXCLUDED."avgLatencyMs"
    `);
  }
}
