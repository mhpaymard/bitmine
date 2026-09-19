import type { ConfigService } from '@nestjs/config';
import { AssetCode } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import type { AlertsService } from '../../src/alerts/alerts.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { AuthenticatedAdmin } from '../../src/auth/auth.types';
import type { Environment } from '../../src/config/environment';
import type { PrismaService } from '../../src/database/prisma.service';
import {
  NetworkFeePayer,
  OperatorPayoutMode,
  PayoutScheduleMode,
  type UpdatePayoutScheduleDto,
} from '../../src/settings/settings.dto';
import { SettingsService } from '../../src/settings/settings.service';
import type { WalletsService } from '../../src/wallets/wallets.service';

afterEach(() => vi.useRealTimers());

const actor = { id: 'admin-id' } as AuthenticatedAdmin;

const payoutPolicyDto: UpdatePayoutScheduleDto = {
  mode: PayoutScheduleMode.DAILY,
  intervalMinutes: 60,
  minuteOffset: 5,
  dailyTime: '00:15',
  timezone: 'Asia/Tehran',
  feePayer: NetworkFeePayer.OPERATOR,
  maxFeeBps: 200,
  maxBatchItems: 500,
  bitcoinMinimumAtomic: '50000',
  moneroMinimumAtomic: '10000000000',
  bitcoinDailyAutoLimitAtomic: '1000000',
  moneroDailyAutoLimitAtomic: '1000000000000',
};

function createService(prisma: object, walletValid = true) {
  const settingUpsert = vi.fn().mockResolvedValue(undefined);
  const validateAddress = vi.fn().mockResolvedValue(walletValid);
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const alertRaise = vi.fn().mockResolvedValue(undefined);
  const alerts = {
    raise: alertRaise,
    resolveByDedupe: vi.fn().mockResolvedValue(undefined),
  } as unknown as AlertsService;
  const database = {
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null), upsert: settingUpsert },
    ...prisma,
  } as unknown as PrismaService;
  return {
    service: new SettingsService(
      database,
      {
        get: (key: string) =>
          key === 'PAYOUT_TIMEZONE'
            ? 'Asia/Tehran'
            : key === 'BITCOIN_MIN_PAYOUT_ATOMIC'
              ? 50_000n
              : 10_000_000_000n,
      } as ConfigService<Environment, true>,
      { forAsset: () => ({ validateAddress }) } as unknown as WalletsService,
      { record: auditRecord } as unknown as AuditService,
      alerts,
    ),
    settingUpsert,
    validateAddress,
    auditRecord,
    alertRaise,
  };
}

describe('payout settings safety', () => {
  it('rejects an invalid IANA timezone before saving a schedule', async () => {
    const { service, settingUpsert } = createService({});

    await expect(
      service.updatePayoutSchedule({ ...payoutPolicyDto, timezone: 'Invalid/Timezone' }, actor),
    ).rejects.toThrow(/Invalid IANA timezone/u);
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it('rejects zero payout minimums before saving a policy', async () => {
    const { service, settingUpsert } = createService({});

    await expect(
      service.updatePayoutSchedule({ ...payoutPolicyDto, bitcoinMinimumAtomic: '0' }, actor),
    ).rejects.toThrow(/Payout minimums must be greater than zero/u);
    expect(settingUpsert).not.toHaveBeenCalled();
  });

  it('claims a configured local payout minute only once per local date', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T20:45:00.000Z'));
    let lastRun: string | null = null;
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      systemSetting: {
        findUnique: vi
          .fn()
          .mockImplementation(() => Promise.resolve(lastRun ? { value: lastRun } : null)),
        upsert: vi.fn().mockImplementation(({ create }: { create: { value: string } }) => {
          lastRun = create.value;
          return Promise.resolve({});
        }),
      },
    };
    const prisma = {
      systemSetting: {
        findUnique: vi.fn().mockResolvedValue({
          value: { time: '00:15', timezone: 'Asia/Tehran' },
        }),
        upsert: vi.fn(),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const { service } = createService(prisma);

    await expect(service.claimScheduledRun()).resolves.toMatchObject({ run: true });
    await expect(service.claimScheduledRun()).resolves.toMatchObject({ run: false });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(lastRun).toBe('daily:Asia/Tehran:2026-09-14');
  });

  it('claims an interval slot once and keeps the payout policy fully dynamic', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T12:05:00.000Z'));
    let lastRun: string | null = null;
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      systemSetting: {
        findUnique: vi
          .fn()
          .mockImplementation(() => Promise.resolve(lastRun ? { value: lastRun } : null)),
        upsert: vi.fn().mockImplementation(({ create }: { create: { value: string } }) => {
          lastRun = create.value;
          return Promise.resolve({});
        }),
      },
    };
    const value = { ...payoutPolicyDto, mode: PayoutScheduleMode.INTERVAL };
    const prisma = {
      systemSetting: {
        findUnique: vi.fn().mockResolvedValue({ value }),
        upsert: vi.fn(),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    const { service } = createService(prisma);

    await expect(service.claimScheduledRun()).resolves.toMatchObject({ run: true });
    await expect(service.claimScheduledRun()).resolves.toMatchObject({ run: false });
    expect(lastRun).toMatch(/^interval:60:5:/u);
  });

  it.each([240, 360])('calculates the next %i-minute customer payout slot', async (minutes) => {
    const value = {
      ...payoutPolicyDto,
      mode: PayoutScheduleMode.INTERVAL,
      intervalMinutes: minutes,
      minuteOffset: 15,
    };
    const { service } = createService({
      systemSetting: {
        findUnique: vi.fn().mockResolvedValue({ value }),
        upsert: vi.fn(),
      },
    });

    const next = await service.nextCustomerPayoutAt(DateTime.fromISO('2026-09-17T10:20:00.000Z'));

    expect(new Date(next.at).getTime()).toBeGreaterThan(
      new Date('2026-09-17T10:20:00.000Z').getTime(),
    );
    expect((new Date(next.at).getTime() - 15 * 60_000) % (minutes * 60_000)).toBe(0);
  });

  it('validates and cools operator payout changes for 24 hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-14T00:00:00.000Z'));
    const { service, settingUpsert, validateAddress, auditRecord, alertRaise } = createService({});

    const value = await service.updateOperatorPayout(
      {
        asset: AssetCode.BTC,
        mode: OperatorPayoutMode.DAILY,
        address: '  valid-operator-address  ',
      },
      actor,
    );

    expect(value).toMatchObject({
      address: 'valid-operator-address',
      minPayoutAtomic: '50000',
      effectiveAt: '2026-09-15T00:00:00.000Z',
    });
    expect(validateAddress).toHaveBeenCalledWith('valid-operator-address');
    expect(settingUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'operator.payout.pending.BTC' } }),
    );
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(alertRaise).toHaveBeenCalledOnce();
  });

  it('does not require a wallet address when operator revenue stays in treasury', async () => {
    const { service, validateAddress } = createService({});

    await expect(
      service.updateOperatorPayout(
        { asset: AssetCode.XMR, mode: OperatorPayoutMode.RETAIN },
        actor,
      ),
    ).resolves.toMatchObject({ mode: OperatorPayoutMode.RETAIN, address: '' });
    expect(validateAddress).not.toHaveBeenCalled();
  });
});
