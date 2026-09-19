import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertSeverity, AssetCode, Prisma } from '@prisma/client';
import { DateTime, IANAZone } from 'luxon';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  NetworkFeePayer,
  OperatorPayoutMode,
  PayoutScheduleMode,
  type UpdateOperatorPayoutDto,
  type UpdatePayoutScheduleDto,
} from './settings.dto';

export interface PayoutPolicySetting {
  mode: PayoutScheduleMode;
  intervalMinutes: number;
  minuteOffset: number;
  dailyTime: string;
  timezone: string;
  feePayer: NetworkFeePayer;
  maxFeeBps: number;
  maxBatchItems: number;
  minimumAtomic: Record<AssetCode, string>;
  dailyAutoLimitAtomic: Record<AssetCode, string>;
}

export interface OperatorPayoutSetting {
  asset: AssetCode;
  mode: OperatorPayoutMode;
  address: string;
  minPayoutAtomic: string;
  weekday: number;
  effectiveAt: string;
}

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Environment, true>,
    private readonly wallets: WalletsService,
    private readonly audit: AuditService,
    private readonly alerts: AlertsService,
  ) {}

  async list() {
    const [schedule, btc, xmr, pendingBtc, pendingXmr] = await Promise.all([
      this.payoutSchedule(),
      this.operatorPayout(AssetCode.BTC),
      this.operatorPayout(AssetCode.XMR),
      this.setting<OperatorPayoutSetting>('operator.payout.pending.BTC'),
      this.setting<OperatorPayoutSetting>('operator.payout.pending.XMR'),
    ]);
    return {
      payoutPolicy: schedule,
      payoutSchedule: { time: schedule.dailyTime, timezone: schedule.timezone },
      operatorPayouts: { BTC: btc, XMR: xmr },
      pendingOperatorPayouts: { BTC: pendingBtc, XMR: pendingXmr },
    };
  }

  async payoutPolicy(): Promise<PayoutPolicySetting> {
    const stored = await this.setting<Partial<PayoutPolicySetting> & { time?: string }>(
      'payout.schedule',
    );
    return {
      mode: stored?.mode ?? PayoutScheduleMode.DAILY,
      intervalMinutes: stored?.intervalMinutes ?? 60,
      minuteOffset: stored?.minuteOffset ?? 5,
      dailyTime: stored?.dailyTime ?? stored?.time ?? '00:15',
      timezone: stored?.timezone ?? this.config.get('PAYOUT_TIMEZONE', { infer: true }),
      feePayer: stored?.feePayer ?? NetworkFeePayer.OPERATOR,
      maxFeeBps: stored?.maxFeeBps ?? 200,
      maxBatchItems: stored?.maxBatchItems ?? 500,
      minimumAtomic: {
        BTC:
          stored?.minimumAtomic?.BTC ??
          this.config.get('BITCOIN_MIN_PAYOUT_ATOMIC', { infer: true }).toString(),
        XMR:
          stored?.minimumAtomic?.XMR ??
          this.config.get('MONERO_MIN_PAYOUT_ATOMIC', { infer: true }).toString(),
      },
      dailyAutoLimitAtomic: {
        BTC:
          stored?.dailyAutoLimitAtomic?.BTC ??
          this.config.get('BITCOIN_DAILY_AUTO_LIMIT_ATOMIC', { infer: true }).toString(),
        XMR:
          stored?.dailyAutoLimitAtomic?.XMR ??
          this.config.get('MONERO_DAILY_AUTO_LIMIT_ATOMIC', { infer: true }).toString(),
      },
    };
  }

  async payoutSchedule(): Promise<PayoutPolicySetting> {
    return this.payoutPolicy();
  }

  async nextCustomerPayoutAt(reference: DateTime<boolean> = DateTime.now()): Promise<{
    at: string;
    localAt: string;
    policy: PayoutPolicySetting;
  }> {
    const policy = await this.payoutPolicy();
    let next: DateTime<boolean>;
    if (policy.mode === PayoutScheduleMode.INTERVAL) {
      const intervalMs = policy.intervalMinutes * 60_000;
      const offsetMs = policy.minuteOffset * 60_000;
      const nextIndex = Math.floor((reference.toMillis() - offsetMs) / intervalMs) + 1;
      next = DateTime.fromMillis(nextIndex * intervalMs + offsetMs, { zone: 'utc' });
    } else {
      const local = reference.setZone(policy.timezone);
      const [hour, minute] = policy.dailyTime.split(':').map(Number);
      const today = local.startOf('day').set({ hour, minute });
      next = local < today ? today : today.plus({ days: 1 });
    }
    return {
      at: next.toUTC().toISO()!,
      localAt: next.setZone(policy.timezone).toISO()!,
      policy,
    };
  }

  async updatePayoutSchedule(dto: UpdatePayoutScheduleDto, actor: AuthenticatedAdmin) {
    if (!IANAZone.isValidZone(dto.timezone)) throw new BadRequestException('Invalid IANA timezone');
    if (BigInt(dto.bitcoinMinimumAtomic) <= 0n || BigInt(dto.moneroMinimumAtomic) <= 0n) {
      throw new BadRequestException('Payout minimums must be greater than zero');
    }
    const before = await this.payoutPolicy();
    const value: PayoutPolicySetting = {
      mode: dto.mode,
      intervalMinutes: dto.intervalMinutes,
      minuteOffset: dto.minuteOffset,
      dailyTime: dto.dailyTime,
      timezone: dto.timezone,
      feePayer: dto.feePayer,
      maxFeeBps: dto.maxFeeBps,
      maxBatchItems: dto.maxBatchItems,
      minimumAtomic: {
        BTC: dto.bitcoinMinimumAtomic,
        XMR: dto.moneroMinimumAtomic,
      },
      dailyAutoLimitAtomic: {
        BTC: dto.bitcoinDailyAutoLimitAtomic,
        XMR: dto.moneroDailyAutoLimitAtomic,
      },
    };
    await this.upsert('payout.schedule', value);
    await this.audit.record({
      actorId: actor.id,
      action: 'PAYOUT_SCHEDULE_UPDATED',
      entityType: 'SystemSetting',
      entityId: 'payout.schedule',
      before,
      after: value,
    });
    return value;
  }

  async updateOperatorPayout(dto: UpdateOperatorPayoutDto, actor: AuthenticatedAdmin) {
    const address = dto.address?.trim() ?? '';
    if (dto.mode !== OperatorPayoutMode.RETAIN) {
      if (!address) throw new BadRequestException('Operator payout address is required');
      if (!(await this.wallets.forAsset(dto.asset).validateAddress(address))) {
        throw new BadRequestException('Invalid operator payout address for selected asset');
      }
    }
    const defaultMinimum =
      dto.asset === AssetCode.BTC
        ? this.config.get('BITCOIN_MIN_PAYOUT_ATOMIC', { infer: true })
        : this.config.get('MONERO_MIN_PAYOUT_ATOMIC', { infer: true });
    const value: OperatorPayoutSetting = {
      asset: dto.asset,
      mode: dto.mode,
      address,
      minPayoutAtomic: dto.minPayoutAtomic ?? defaultMinimum.toString(),
      weekday: dto.weekday ?? 1,
      effectiveAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    };
    await this.upsert(`operator.payout.pending.${dto.asset}`, value);
    await this.audit.record({
      actorId: actor.id,
      action: 'OPERATOR_PAYOUT_SETTING_PENDING',
      entityType: 'SystemSetting',
      entityId: `operator.payout.${dto.asset}`,
      after: value,
    });
    await this.alerts.raise({
      dedupeKey: `operator-payout-destination:${dto.asset}`,
      severity: AlertSeverity.WARNING,
      title: `${dto.asset} operator payout setting is pending`,
      message: `The operator payout change is cooling until ${value.effectiveAt}`,
      metadata: { asset: dto.asset, mode: dto.mode, effectiveAt: value.effectiveAt },
    });
    return value;
  }

  async operatorPayout(asset: AssetCode): Promise<OperatorPayoutSetting> {
    await this.activateDueOperatorPayouts();
    return (
      (await this.setting<OperatorPayoutSetting>(`operator.payout.active.${asset}`)) ?? {
        asset,
        mode: OperatorPayoutMode.RETAIN,
        address: '',
        minPayoutAtomic: (asset === AssetCode.BTC
          ? this.config.get('BITCOIN_MIN_PAYOUT_ATOMIC', { infer: true })
          : this.config.get('MONERO_MIN_PAYOUT_ATOMIC', { infer: true })
        ).toString(),
        weekday: 1,
        effectiveAt: new Date(0).toISOString(),
      }
    );
  }

  async activateDueOperatorPayouts(): Promise<void> {
    for (const asset of [AssetCode.BTC, AssetCode.XMR]) {
      const key = `operator.payout.pending.${asset}`;
      const pending = await this.setting<OperatorPayoutSetting>(key);
      if (!pending || new Date(pending.effectiveAt) > new Date()) continue;
      await this.prisma.$transaction([
        this.prisma.systemSetting.upsert({
          where: { key: `operator.payout.active.${asset}` },
          create: {
            key: `operator.payout.active.${asset}`,
            value: pending as unknown as Prisma.InputJsonValue,
          },
          update: { value: pending as unknown as Prisma.InputJsonValue },
        }),
        this.prisma.systemSetting.delete({ where: { key } }),
      ]);
      await this.alerts.resolveByDedupe(`operator-payout-destination:${asset}`);
    }
  }

  async claimScheduledRun(): Promise<{ run: boolean; local: DateTime }> {
    const schedule = await this.payoutPolicy();
    const now = DateTime.now();
    const local = now.setZone(schedule.timezone);
    if (!local.isValid) return { run: false, local };
    let slot: string;
    if (schedule.mode === PayoutScheduleMode.DAILY) {
      const [hour, minute] = schedule.dailyTime.split(':').map(Number);
      const due = local.startOf('day').set({ hour, minute });
      const day = local.toISODate();
      if (!day || local < due) return { run: false, local };
      slot = `daily:${schedule.timezone}:${day}`;
    } else {
      const intervalMs = schedule.intervalMinutes * 60_000;
      const offsetMs = schedule.minuteOffset * 60_000;
      const index = Math.floor((now.toMillis() - offsetMs) / intervalMs);
      slot = `interval:${schedule.intervalMinutes}:${schedule.minuteOffset}:${index}`;
    }
    const run = await this.claimSlot('payout.schedule.lastRunSlot', slot);
    return { run, local };
  }

  async claimOperatorScheduledRun(): Promise<{ run: boolean; local: DateTime }> {
    const schedule = await this.payoutPolicy();
    const local = DateTime.now().setZone(schedule.timezone);
    if (!local.isValid) return { run: false, local };
    const [hour, minute] = schedule.dailyTime.split(':').map(Number);
    const due = local.startOf('day').set({ hour, minute });
    const day = local.toISODate();
    if (!day || local < due) return { run: false, local };
    const run = await this.claimSlot(
      'operator.payout.schedule.lastRunSlot',
      `daily:${schedule.timezone}:${day}`,
    );
    return { run, local };
  }

  private async claimSlot(key: string, slot: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const previous = await tx.systemSetting.findUnique({ where: { key } });
      if (previous?.value === slot) return false;
      await tx.systemSetting.upsert({
        where: { key },
        create: { key, value: slot },
        update: { value: slot },
      });
      return true;
    });
  }

  private async setting<T>(key: string): Promise<T | null> {
    const setting = await this.prisma.systemSetting.findUnique({ where: { key } });
    return setting ? (setting.value as T) : null;
  }

  private async upsert(key: string, value: object): Promise<void> {
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }
}
