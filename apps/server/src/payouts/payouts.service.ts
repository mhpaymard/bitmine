import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  AlertSeverity,
  AssetCode,
  DestinationStatus,
  PayoutKind,
  PayoutState,
} from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import { AuthService } from '../auth/auth.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { CustomersService } from '../customers/customers.service';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import { CryptoService } from '../security/crypto.service';
import { OperatorPayoutMode } from '../settings/settings.dto';
import { SettingsService } from '../settings/settings.service';
import { DepositsService } from '../wallets/deposits.service';
import { WalletsService } from '../wallets/wallets.service';
import { assertPayoutTransition } from './payout-state';

const OPEN_PAYOUT_STATES = [
  PayoutState.PLANNED,
  PayoutState.APPROVAL_REQUIRED,
  PayoutState.AUTO_APPROVED,
  PayoutState.SIGNED,
  PayoutState.BROADCAST,
];

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
    private readonly customers: CustomersService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly wallets: WalletsService,
    private readonly deposits: DepositsService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly events: EventsService,
    private readonly alerts: AlertsService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
  ) {}

  async list(asset?: AssetCode) {
    const batches = await this.prisma.payoutBatch.findMany({
      where: asset ? { asset } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { customer: { select: { id: true, displayName: true, slug: true } } } },
        approvedBy: { select: { id: true, email: true, displayName: true, role: true } },
      },
      take: 500,
    });
    return batches.map((batch) => this.safeBatch(batch));
  }

  async plan(asset: AssetCode) {
    await this.customers.activateDueDestinations();
    const batch = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-plan:${asset}`}))`;
        const destinations = await tx.payoutDestination.findMany({
          where: {
            asset,
            status: DestinationStatus.ACTIVE,
            effectiveAt: { lte: new Date() },
            customer: { status: 'ACTIVE' },
          },
          include: { customer: true },
        });
        const items: Array<{
          customerId: string;
          destination: string;
          grossAtomic: bigint;
          netAtomic: bigint;
        }> = [];
        for (const destination of destinations) {
          const balance = await this.ledger.customerBalance(destination.customerId, asset, tx);
          const reserved = await tx.payoutItem.findMany({
            where: {
              customerId: destination.customerId,
              batch: { asset, state: { in: OPEN_PAYOUT_STATES } },
            },
            select: { grossAtomic: true },
          });
          const available = balance - reserved.reduce((sum, item) => sum + item.grossAtomic, 0n);
          if (available >= destination.minPayoutAtomic) {
            items.push({
              customerId: destination.customerId,
              destination: destination.address,
              grossAtomic: available,
              netAtomic: available,
            });
          }
        }
        if (!items.length) return null;
        const total = items.reduce((sum, item) => sum + item.grossAtomic, 0n);
        const autoLimit =
          asset === AssetCode.BTC
            ? this.config.get('BITCOIN_DAILY_AUTO_LIMIT_ATOMIC', { infer: true })
            : this.config.get('MONERO_DAILY_AUTO_LIMIT_ATOMIC', { infer: true });
        const auto = autoLimit > 0n && total <= autoLimit;
        return tx.payoutBatch.create({
          data: {
            asset,
            kind: PayoutKind.CUSTOMER,
            state: auto ? PayoutState.AUTO_APPROVED : PayoutState.APPROVAL_REQUIRED,
            scheduledFor: new Date(),
            totalGrossAtomic: total,
            totalNetAtomic: total,
            approvalThresholdHit: !auto,
            items: { create: items },
          },
          include: { items: true },
        });
      },
      { isolationLevel: 'Serializable', timeout: 30_000 },
    );
    if (!batch) return null;
    this.events.publish('payout.planned', {
      id: batch.id,
      asset,
      totalAtomic: batch.totalGrossAtomic.toString(),
      state: batch.state,
    });
    return batch;
  }

  async planOperator(asset: AssetCode) {
    const setting = await this.settings.operatorPayout(asset);
    if (setting.mode === OperatorPayoutMode.RETAIN || !setting.address) {
      throw new ConflictException('Operator revenue is configured to remain in treasury');
    }
    const batch = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout-plan:${asset}`}))`;
        const balance = await this.ledger.operatorBalance(asset, tx);
        const reserved = await tx.payoutItem.findMany({
          where: {
            customerId: null,
            batch: { asset, kind: PayoutKind.OPERATOR, state: { in: OPEN_PAYOUT_STATES } },
          },
          select: { grossAtomic: true },
        });
        const available = balance - reserved.reduce((sum, item) => sum + item.grossAtomic, 0n);
        if (available < BigInt(setting.minPayoutAtomic)) return null;
        const autoLimit =
          asset === AssetCode.BTC
            ? this.config.get('BITCOIN_DAILY_AUTO_LIMIT_ATOMIC', { infer: true })
            : this.config.get('MONERO_DAILY_AUTO_LIMIT_ATOMIC', { infer: true });
        const auto = autoLimit > 0n && available <= autoLimit;
        return tx.payoutBatch.create({
          data: {
            asset,
            kind: PayoutKind.OPERATOR,
            state: auto ? PayoutState.AUTO_APPROVED : PayoutState.APPROVAL_REQUIRED,
            scheduledFor: new Date(),
            totalGrossAtomic: available,
            totalNetAtomic: available,
            approvalThresholdHit: !auto,
            items: {
              create: {
                customerId: null,
                destination: setting.address,
                grossAtomic: available,
                netAtomic: available,
              },
            },
          },
          include: { items: true },
        });
      },
      { isolationLevel: 'Serializable', timeout: 30_000 },
    );
    if (!batch) return null;
    this.events.publish('payout.operator.planned', {
      id: batch.id,
      asset,
      totalAtomic: batch.totalGrossAtomic.toString(),
      state: batch.state,
    });
    return batch;
  }

  async approve(id: string, admin: AuthenticatedAdmin, totpCode: string) {
    await this.auth.assertTotp(admin.id, totpCode);
    const batch = await this.prisma.payoutBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException('Payout batch not found');
    if (batch.state !== PayoutState.APPROVAL_REQUIRED && batch.state !== PayoutState.FAILED) {
      throw new ConflictException(`Payout cannot be approved from ${batch.state}`);
    }
    const nextState =
      batch.state === PayoutState.FAILED && batch.signedPayload
        ? PayoutState.SIGNED
        : PayoutState.AUTO_APPROVED;
    assertPayoutTransition(batch.state, nextState);
    const updated = await this.prisma.payoutBatch.update({
      where: { id },
      data: {
        state: nextState,
        approvedById: admin.id,
        approvedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    await this.audit.record({
      actorId: admin.id,
      action: 'PAYOUT_APPROVED',
      entityType: 'PayoutBatch',
      entityId: id,
      after: this.safeBatch(updated),
    });
    return this.safeBatch(updated);
  }

  async execute(id: string) {
    await this.redis.connect();
    const lockKey = 'payout:execute:wallets';
    const lockToken = randomUUID();
    const lockTtlMs = 600_000;
    const acquired = await this.redis.client.set(lockKey, lockToken, 'PX', lockTtlMs, 'NX');
    if (acquired !== 'OK')
      throw new ConflictException('Another wallet payout is already being executed');
    let lockLost = false;
    let renewalInProgress = false;
    const renew = async () => {
      if (renewalInProgress) return;
      renewalInProgress = true;
      try {
        const renewed = Number(
          await this.redis.client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
            1,
            lockKey,
            lockToken,
            lockTtlMs,
          ),
        );
        if (renewed !== 1) lockLost = true;
      } catch {
        lockLost = true;
      } finally {
        renewalInProgress = false;
      }
    };
    const renewal = setInterval(() => void renew(), 60_000);
    renewal.unref();
    const assertLock = () => {
      if (lockLost) throw new ConflictException('Payout execution lock was lost');
    };
    try {
      return await this.executeUnderLock(id, assertLock);
    } finally {
      clearInterval(renewal);
      await this.redis.client.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockToken,
      );
    }
  }

  private async executeUnderLock(id: string, assertLock: () => void) {
    assertLock();
    const reorg = await this.prisma.deposit.findFirst({ where: { status: 'REORGED' } });
    if (reorg)
      throw new ConflictException('Payouts are halted because an allocated deposit was reorged');
    let batch = await this.prisma.payoutBatch.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!batch) throw new NotFoundException('Payout batch not found');
    if (
      batch.state !== PayoutState.AUTO_APPROVED &&
      batch.state !== PayoutState.SIGNED &&
      batch.state !== PayoutState.FAILED
    ) {
      throw new ConflictException(`Payout cannot execute from ${batch.state}`);
    }
    const wallet = this.wallets.forAsset(batch.asset);
    try {
      if (!batch.signedPayload) {
        assertLock();
        const prepared = await wallet.preparePayout(
          batch.items.map((item) => ({
            id: item.id,
            address: item.destination,
            grossAtomic: item.grossAtomic,
          })),
        );
        assertLock();
        assertPayoutTransition(batch.state, PayoutState.SIGNED);
        await this.prisma.$transaction(async (tx) => {
          for (const item of prepared.items) {
            await tx.payoutItem.update({
              where: { id: item.id },
              data: { allocatedFeeAtomic: item.allocatedFeeAtomic, netAtomic: item.netAtomic },
            });
          }
          await tx.payoutBatch.update({
            where: { id },
            data: {
              state: PayoutState.SIGNED,
              signedPayload: this.crypto.encrypt(
                prepared.signedPayload,
                `payout:${id}:signed-payload`,
              ),
              transactionIds: prepared.transactionIds,
              totalFeeAtomic: prepared.feeAtomic,
              totalNetAtomic: prepared.items.reduce((sum, item) => sum + item.netAtomic, 0n),
              errorCode: null,
              errorMessage: null,
            },
          });
        });
        const refreshed = await this.prisma.payoutBatch.findUniqueOrThrow({
          where: { id },
          include: { items: true },
        });
        batch = refreshed;
      }
      const signedPayload = batch?.signedPayload;
      if (!signedPayload) throw new Error('Signed payout payload is missing');
      const decryptedPayload = signedPayload.startsWith('v1.')
        ? this.crypto.decrypt(signedPayload, `payout:${id}:signed-payload`)
        : signedPayload;
      const executableBatch = batch;
      const expectedIds = executableBatch.transactionIds;
      assertLock();
      const alreadyBroadcast =
        expectedIds.length > 0 &&
        (await Promise.all(expectedIds.map((txid) => wallet.transactionKnown(txid)))).every(
          Boolean,
        );
      assertLock();
      const transactionIds = alreadyBroadcast
        ? expectedIds
        : await wallet.broadcast(decryptedPayload);
      assertLock();
      assertPayoutTransition(executableBatch.state, PayoutState.BROADCAST);
      await this.prisma.$transaction(async (tx) => {
        for (const item of executableBatch.items) {
          if (item.journalTransactionId) continue;
          const journal = item.customerId
            ? await this.ledger.postPayout(tx, {
                batchId: executableBatch.id,
                asset: executableBatch.asset,
                customerId: item.customerId,
                grossAtomic: item.grossAtomic,
                feeAtomic: item.allocatedFeeAtomic,
              })
            : await this.ledger.postOperatorPayout(tx, {
                batchId: executableBatch.id,
                asset: executableBatch.asset,
                grossAtomic: item.grossAtomic,
                feeAtomic: item.allocatedFeeAtomic,
              });
          await tx.payoutItem.update({
            where: { id: item.id },
            data: { journalTransactionId: journal.id },
          });
        }
        await tx.payoutBatch.update({
          where: { id },
          data: {
            state: PayoutState.BROADCAST,
            transactionIds,
            broadcastAt: new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
      });
      this.events.publish('payout.broadcast', { id, asset: executableBatch.asset, transactionIds });
      const result = await this.prisma.payoutBatch.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });
      return this.safeBatch(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.payoutBatch.update({
        where: { id },
        data: {
          state: PayoutState.FAILED,
          errorCode: 'EXECUTION_FAILED',
          errorMessage: message.slice(0, 5000),
        },
      });
      this.events.publish('payout.failed', { id, asset: batch.asset, message });
      await this.alerts.raise({
        dedupeKey: `payout:${id}`,
        severity: AlertSeverity.CRITICAL,
        title: `${batch.asset} payout failed`,
        message,
        metadata: { payoutBatchId: id, state: batch.state },
      });
      throw error;
    }
  }

  async reconcile(): Promise<void> {
    const batches = await this.prisma.payoutBatch.findMany({
      where: { state: PayoutState.BROADCAST },
    });
    for (const batch of batches) {
      const required =
        batch.asset === AssetCode.BTC
          ? this.config.get('BITCOIN_CONFIRMATIONS', { infer: true })
          : this.config.get('MONERO_CONFIRMATIONS', { infer: true });
      const confirmations = await Promise.all(
        batch.transactionIds.map((txid) =>
          this.wallets.forAsset(batch.asset).transactionConfirmations(txid),
        ),
      );
      if (confirmations.length && confirmations.every((count) => count >= required)) {
        assertPayoutTransition(batch.state, PayoutState.CONFIRMED);
        await this.prisma.payoutBatch.update({
          where: { id: batch.id },
          data: { state: PayoutState.CONFIRMED, confirmedAt: new Date() },
        });
        this.events.publish('payout.confirmed', {
          id: batch.id,
          asset: batch.asset,
          transactionIds: batch.transactionIds,
        });
      }
    }
  }

  @Interval(60_000)
  async scheduled(): Promise<void> {
    if (this.running) return;
    const claim = await this.settings.claimScheduledRun().catch(() => null);
    if (!claim?.run) return;
    this.running = true;
    try {
      await this.deposits.scanAll();
      for (const asset of [AssetCode.BTC, AssetCode.XMR]) {
        const batch = await this.plan(asset);
        if (batch?.state === PayoutState.AUTO_APPROVED) await this.execute(batch.id);
        const operator = await this.settings.operatorPayout(asset);
        const due =
          operator.mode === OperatorPayoutMode.DAILY ||
          (operator.mode === OperatorPayoutMode.WEEKLY && operator.weekday === claim.local.weekday);
        if (due) {
          const operatorBatch = await this.planOperator(asset);
          if (operatorBatch?.state === PayoutState.AUTO_APPROVED)
            await this.execute(operatorBatch.id);
        }
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.stack : String(error));
    } finally {
      this.running = false;
    }
  }

  @Interval(60_000)
  async monitor(): Promise<void> {
    await this.deposits.scanAll().catch(() => undefined);
    await this.reconcile().catch((error: unknown) => {
      this.logger.warn(
        `Payout reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private safeBatch<T extends { signedPayload: string | null }>(batch: T) {
    const { signedPayload, ...safe } = batch;
    return { ...safe, hasSignedPayload: Boolean(signedPayload) };
  }
}
