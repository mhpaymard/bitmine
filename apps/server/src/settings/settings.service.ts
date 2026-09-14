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
  OperatorPayoutMode,
  type UpdateOperatorPayoutDto,
  type UpdatePayoutScheduleDto,
} from './settings.dto';

export interface PayoutScheduleSetting {
  time: string;
  timezone: string;
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
      payoutSchedule: schedule,
      operatorPayouts: { BTC: btc, XMR: xmr },
      pendingOperatorPayouts: { BTC: pendingBtc, XMR: pendingXmr },
    };
  }

  async payoutSchedule(): Promise<PayoutScheduleSetting> {
    return (
      (await this.setting<PayoutScheduleSetting>('payout.schedule')) ?? {
        time: '00:15',
        timezone: this.config.get('PAYOUT_TIMEZONE', { infer: true }),
      }
    );
  }

  async updatePayoutSchedule(dto: UpdatePayoutScheduleDto, actor: AuthenticatedAdmin) {
    if (!IANAZone.isValidZone(dto.timezone)) throw new BadRequestException('Invalid IANA timezone');
    const before = await this.payoutSchedule();
    const value: PayoutScheduleSetting = { time: dto.time, timezone: dto.timezone };
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
    const schedule = await this.payoutSchedule();
    const local = DateTime.now().setZone(schedule.timezone);
    if (!local.isValid || local.toFormat('HH:mm') !== schedule.time) return { run: false, local };
    const day = local.toISODate();
    if (!day) return { run: false, local };
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('payout.schedule.claim'))`;
      const previous = await tx.systemSetting.findUnique({
        where: { key: 'payout.schedule.lastRunDate' },
      });
      if (previous?.value === day) return false;
      await tx.systemSetting.upsert({
        where: { key: 'payout.schedule.lastRunDate' },
        create: { key: 'payout.schedule.lastRunDate', value: day },
        update: { value: day },
      });
      return true;
    });
    return { run, local };
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
