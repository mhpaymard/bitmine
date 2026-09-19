import {
  BadRequestException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AlertSeverity,
  AssetCode,
  DestinationStatus,
  EntityStatus,
  PayoutState,
  ShareStatus,
} from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { CryptoService } from '../security/crypto.service';
import { SettingsService } from '../settings/settings.service';
import { WalletsService } from '../wallets/wallets.service';
import type { PortalAccessDto, PortalDestinationDto } from './public-portal.dto';

const RESERVED_PAYOUT_STATES = [
  PayoutState.PLANNED,
  PayoutState.APPROVAL_REQUIRED,
  PayoutState.AUTO_APPROVED,
  PayoutState.SIGNED,
  PayoutState.BROADCAST,
  PayoutState.FAILED,
];

@Injectable()
export class PublicPortalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly wallets: WalletsService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
  ) {}

  async summary(credentials: PortalAccessDto, ipAddress: string) {
    const customer = await this.authenticate(credentials, ipAddress);
    const [schedule, workers, balances, earnings, payouts, destinations] = await Promise.all([
      this.settings.nextCustomerPayoutAt(),
      this.workerStats(customer.id),
      Promise.all([AssetCode.BTC, AssetCode.XMR].map((asset) => this.balance(customer.id, asset))),
      Promise.all([AssetCode.BTC, AssetCode.XMR].map((asset) => this.earnings(customer.id, asset))),
      this.prisma.payoutItem.findMany({
        where: { customerId: customer.id },
        orderBy: { batch: { createdAt: 'desc' } },
        take: 20,
        select: {
          id: true,
          grossAtomic: true,
          allocatedFeeAtomic: true,
          netAtomic: true,
          destination: true,
          batch: {
            select: {
              asset: true,
              state: true,
              scheduledFor: true,
              createdAt: true,
              broadcastAt: true,
              confirmedAt: true,
              transactionIds: true,
            },
          },
        },
      }),
      this.prisma.payoutDestination.findMany({
        where: { customerId: customer.id, status: { not: DestinationStatus.REVOKED } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      customer: {
        slug: customer.slug,
        displayName: customer.displayName,
        timezone: customer.timezone,
      },
      payoutSchedule: {
        mode: schedule.policy.mode,
        intervalMinutes: schedule.policy.intervalMinutes,
        dailyTime: schedule.policy.dailyTime,
        timezone: schedule.policy.timezone,
        nextAt: schedule.at,
        nextLocalAt: schedule.localAt,
        feePayer: schedule.policy.feePayer,
      },
      workers,
      balances: balances.map((balance) => {
        const assetDestinations = destinations.filter(
          (destination) => destination.asset === balance.asset,
        );
        const active = assetDestinations.find(
          (destination) => destination.status === DestinationStatus.ACTIVE,
        );
        const pending = assetDestinations.find(
          (destination) => destination.status === DestinationStatus.PENDING,
        );
        const policyMinimum = BigInt(schedule.policy.minimumAtomic[balance.asset]);
        const effectiveMinimum =
          active && active.minPayoutAtomic > policyMinimum ? active.minPayoutAtomic : policyMinimum;
        return {
          ...balance,
          minimumAtomic: effectiveMinimum.toString(),
          eligibleAtNextRun: Boolean(active && BigInt(balance.payableAtomic) >= effectiveMinimum),
          autoApprovalConfigured: BigInt(schedule.policy.dailyAutoLimitAtomic[balance.asset]) > 0n,
          activeDestination: active ? this.safeDestination(active) : null,
          pendingDestination: pending ? this.safeDestination(pending) : null,
        };
      }),
      earnings,
      payouts: payouts.map((item) => ({
        ...item,
        grossAtomic: item.grossAtomic.toString(),
        allocatedFeeAtomic: item.allocatedFeeAtomic.toString(),
        netAtomic: item.netAtomic.toString(),
        destination: this.maskAddress(item.destination),
      })),
      estimateBasis: 'ACTUAL_TRAILING_24H',
    };
  }

  async requestDestination(input: PortalDestinationDto, ipAddress: string) {
    const customer = await this.authenticate(input, ipAddress);
    const address = input.address.trim();
    if (!(await this.wallets.forAsset(input.asset).validateAddress(address)))
      throw new BadRequestException('Invalid payout address for selected asset');
    const policy = await this.settings.payoutPolicy();
    const globalMinimum = BigInt(policy.minimumAtomic[input.asset]);
    const requestedMinimum = input.minPayoutAtomic ? BigInt(input.minPayoutAtomic) : globalMinimum;
    if (requestedMinimum <= 0n) throw new BadRequestException('Payout minimum must be positive');
    const minPayoutAtomic = requestedMinimum > globalMinimum ? requestedMinimum : globalMinimum;
    const effectiveAt = new Date(Date.now() + 24 * 60 * 60_000);
    const destination = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portal-destination:${customer.id}:${input.asset}`}))`;
      await tx.payoutDestination.updateMany({
        where: {
          customerId: customer.id,
          asset: input.asset,
          status: DestinationStatus.PENDING,
        },
        data: { status: DestinationStatus.REVOKED, revokedAt: new Date() },
      });
      return tx.payoutDestination.create({
        data: {
          customerId: customer.id,
          asset: input.asset,
          address,
          status: DestinationStatus.PENDING,
          effectiveAt,
          minPayoutAtomic,
        },
      });
    });
    await this.audit.record({
      action: 'CUSTOMER_PORTAL_PAYOUT_DESTINATION_REQUESTED',
      entityType: 'PayoutDestination',
      entityId: destination.id,
      ipAddress,
      after: {
        customerId: customer.id,
        asset: input.asset,
        address: this.maskAddress(address),
        effectiveAt,
        minPayoutAtomic: minPayoutAtomic.toString(),
      },
    });
    await this.alerts.raise({
      dedupeKey: `payout-destination:${customer.id}:${input.asset}`,
      severity: AlertSeverity.WARNING,
      title: `${input.asset} payout destination requested from customer portal`,
      message: `The address change is cooling until ${effectiveAt.toISOString()}`,
      metadata: { customerId: customer.id, destinationId: destination.id, effectiveAt },
    });
    return this.safeDestination(destination);
  }

  private async authenticate(credentials: PortalAccessDto, ipAddress: string) {
    await this.checkRateLimit(ipAddress);
    const customer = await this.prisma.customer.findUnique({
      where: { slug: credentials.customerSlug },
      include: { portalCredential: true },
    });
    const valid = Boolean(
      customer &&
      customer.status === EntityStatus.ACTIVE &&
      customer.portalCredential &&
      !customer.portalCredential.revokedAt &&
      (await this.crypto.verifySecret(customer.portalCredential.tokenHash, credentials.accessCode)),
    );
    if (!valid || !customer) throw new UnauthorizedException('Invalid portal credentials');
    return customer;
  }

  private async checkRateLimit(ipAddress: string): Promise<void> {
    await this.redis.connect();
    const key = `portal:attempt:${this.crypto.sha256(ipAddress)}`;
    const attempts = await this.redis.client.incr(key);
    if (attempts === 1) await this.redis.client.expire(key, 60);
    if (attempts > 10) throw new HttpException('Too many portal requests', 429);
  }

  private async balance(customerId: string, asset: AssetCode) {
    const [confirmed, reserved, pending] = await Promise.all([
      this.ledger.customerBalance(customerId, asset),
      this.prisma.payoutItem.aggregate({
        where: { customerId, batch: { asset, state: { in: RESERVED_PAYOUT_STATES } } },
        _sum: { grossAtomic: true },
      }),
      this.prisma.shareEvent.aggregate({
        where: {
          customerId,
          asset,
          status: ShareStatus.ACCEPTED,
          allocationBatchId: null,
        },
        _count: { _all: true },
        _sum: { normalizedWork: true },
      }),
    ]);
    const reservedAtomic = reserved._sum.grossAtomic ?? 0n;
    const payableAtomic = confirmed - reservedAtomic;
    return {
      asset,
      confirmedAtomic: confirmed.toString(),
      reservedAtomic: reservedAtomic.toString(),
      payableAtomic: (payableAtomic > 0n ? payableAtomic : 0n).toString(),
      pendingAcceptedShares: String(pending._count._all),
      pendingAcceptedWork: pending._sum.normalizedWork?.toString() ?? '0',
    };
  }

  private async earnings(customerId: string, asset: AssetCode) {
    const [trailing24h, trailing7d] = await Promise.all([
      this.prisma.allocationItem.aggregate({
        where: {
          customerId,
          allocationBatch: { asset, createdAt: { gte: new Date(Date.now() - 86_400_000) } },
        },
        _sum: { customerAtomic: true },
      }),
      this.prisma.allocationItem.aggregate({
        where: {
          customerId,
          allocationBatch: { asset, createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
        },
        _sum: { customerAtomic: true },
      }),
    ]);
    const earned24h = trailing24h._sum.customerAtomic ?? 0n;
    const earned7d = trailing7d._sum.customerAtomic ?? 0n;
    return {
      asset,
      earnedTrailing24hAtomic: earned24h.toString(),
      earnedTrailing7dAtomic: earned7d.toString(),
      projectedNext24hAtomic: earned24h.toString(),
    };
  }

  private async workerStats(customerId: string) {
    const workers = await this.prisma.worker.findMany({
      where: { customerId },
      orderBy: [{ asset: 'asc' }, { slug: 'asc' }],
      include: { connections: { where: { disconnectedAt: null }, select: { id: true } } },
    });
    const now = Date.now();
    const windows = [1, 5, 15] as const;
    const work = new Map<number, Map<string, number>>();
    for (const minutes of windows) {
      const groups = await this.prisma.shareEvent.groupBy({
        by: ['workerId'],
        where: {
          customerId,
          status: ShareStatus.ACCEPTED,
          submittedAt: { gte: new Date(now - minutes * 60_000) },
        },
        _sum: { normalizedWork: true },
      });
      work.set(
        minutes,
        new Map(
          groups.map((group) => [
            group.workerId,
            Number(group._sum.normalizedWork?.toString() ?? '0'),
          ]),
        ),
      );
    }
    const shares = await this.prisma.shareEvent.groupBy({
      by: ['workerId', 'status'],
      where: {
        customerId,
        status: { in: [ShareStatus.ACCEPTED, ShareStatus.REJECTED] },
        submittedAt: { gte: new Date(now - 86_400_000) },
      },
      _count: { _all: true },
    });
    return workers.map((worker) => ({
      id: worker.id,
      slug: worker.slug,
      asset: worker.asset,
      status: worker.status,
      connected: worker.connections.length > 0,
      activeConnections: worker.connections.length,
      lastSeenAt: worker.lastSeenAt,
      hashrate1m: (work.get(1)?.get(worker.id) ?? 0) / 60,
      hashrate5m: (work.get(5)?.get(worker.id) ?? 0) / 300,
      hashrate15m: (work.get(15)?.get(worker.id) ?? 0) / 900,
      accepted24h:
        shares.find(
          (share) => share.workerId === worker.id && share.status === ShareStatus.ACCEPTED,
        )?._count._all ?? 0,
      rejected24h:
        shares.find(
          (share) => share.workerId === worker.id && share.status === ShareStatus.REJECTED,
        )?._count._all ?? 0,
    }));
  }

  private safeDestination(destination: {
    id: string;
    asset: AssetCode;
    address: string;
    status: DestinationStatus;
    effectiveAt: Date;
    minPayoutAtomic: bigint;
  }) {
    return {
      id: destination.id,
      asset: destination.asset,
      address: this.maskAddress(destination.address),
      status: destination.status,
      effectiveAt: destination.effectiveAt,
      minPayoutAtomic: destination.minPayoutAtomic.toString(),
    };
  }

  private maskAddress(address: string): string {
    if (address.length <= 16) return `${address.slice(0, 4)}…${address.slice(-4)}`;
    return `${address.slice(0, 8)}…${address.slice(-8)}`;
  }
}
