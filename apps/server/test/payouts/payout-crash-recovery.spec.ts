import { AssetCode, PayoutKind, PayoutState } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AlertsService } from '../../src/alerts/alerts.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { AuthService } from '../../src/auth/auth.service';
import type { Environment } from '../../src/config/environment';
import type { CustomersService } from '../../src/customers/customers.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { EventsService } from '../../src/events/events.service';
import type { LedgerService } from '../../src/ledger/ledger.service';
import { PayoutsService } from '../../src/payouts/payouts.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { CryptoService } from '../../src/security/crypto.service';
import type { SettingsService } from '../../src/settings/settings.service';
import { NetworkFeePayer, PayoutScheduleMode } from '../../src/settings/settings.dto';
import type { DepositsService } from '../../src/wallets/deposits.service';
import type { WalletsService } from '../../src/wallets/wallets.service';
import type { ConfigService } from '@nestjs/config';

describe('payout crash recovery', () => {
  const payoutPolicy = {
    mode: PayoutScheduleMode.DAILY,
    intervalMinutes: 60,
    minuteOffset: 5,
    dailyTime: '00:15',
    timezone: 'Asia/Tehran',
    feePayer: NetworkFeePayer.OPERATOR,
    maxFeeBps: 200,
    maxBatchItems: 500,
    minimumAtomic: { BTC: '100', XMR: '100' },
    dailyAutoLimitAtomic: { BTC: '0', XMR: '0' },
  };
  it('never exposes encrypted signed payloads through the list API', async () => {
    const prisma = {
      payoutBatch: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'batch-secret', signedPayload: 'v1.secret.ciphertext' }]),
      },
    } as unknown as PrismaService;
    const service = new PayoutsService(
      prisma,
      {} as ConfigService<Environment, true>,
      {} as CustomersService,
      {} as LedgerService,
      {} as SettingsService,
      {} as WalletsService,
      {} as DepositsService,
      {} as AuthService,
      {} as AuditService,
      {} as EventsService,
      {} as AlertsService,
      {} as RedisService,
      {} as CryptoService,
    );

    const result = await service.list();

    expect(result).toEqual([{ id: 'batch-secret', hasSignedPayload: true }]);
    expect(result[0]).not.toHaveProperty('signedPayload');
  });

  it('restores a failed batch with a signed payload to SIGNED without preparing it again', async () => {
    const batch = {
      id: 'batch-signed-failed',
      asset: AssetCode.BTC,
      state: PayoutState.FAILED,
      signedPayload: 'already-signed',
    };
    const update = vi
      .fn<(input: { data: Partial<typeof batch> }) => Promise<typeof batch>>()
      .mockImplementation(({ data }) => Promise.resolve({ ...batch, ...data }));
    const prisma = {
      payoutBatch: { findUnique: vi.fn().mockResolvedValue(batch), update },
    } as unknown as PrismaService;
    const auth = { assertTotp: vi.fn().mockResolvedValue(undefined) } as unknown as AuthService;
    const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
    const service = new PayoutsService(
      prisma,
      {} as ConfigService<Environment, true>,
      {} as CustomersService,
      {} as LedgerService,
      {} as SettingsService,
      {} as WalletsService,
      {} as DepositsService,
      auth,
      audit,
      {} as EventsService,
      {} as AlertsService,
      {} as RedisService,
      {} as CryptoService,
    );

    const result = await service.approve(
      batch.id,
      { id: 'owner-id', role: 'OWNER' } as never,
      '123456',
    );

    expect(result.state).toBe(PayoutState.SIGNED);
    expect(update.mock.calls[0]?.[0].data.state).toBe(PayoutState.SIGNED);
  });

  it('takes a database advisory lock before reserving customer balances', async () => {
    const created = {
      id: 'batch-locked',
      asset: AssetCode.BTC,
      state: PayoutState.APPROVAL_REQUIRED,
      totalGrossAtomic: 1000n,
    };
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      payoutDestination: {
        findMany: vi.fn().mockResolvedValue([
          {
            customerId: 'customer-1',
            address: 'destination',
            minPayoutAtomic: 100n,
          },
        ]),
      },
      payoutItem: { findMany: vi.fn().mockResolvedValue([]) },
      payoutBatch: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { totalGrossAtomic: 600n } }),
        create: vi.fn().mockResolvedValue(created),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const customers = {
      activateDueDestinations: vi.fn().mockResolvedValue(0),
    } as unknown as CustomersService;
    const ledger = {
      customerBalance: vi.fn().mockResolvedValue(1000n),
    } as unknown as LedgerService;
    const config = { get: vi.fn().mockReturnValue(0n) } as unknown as ConfigService<
      Environment,
      true
    >;
    const events = { publish: vi.fn() } as unknown as EventsService;
    const service = new PayoutsService(
      prisma,
      config,
      customers,
      ledger,
      {
        payoutPolicy: vi.fn().mockResolvedValue({
          ...payoutPolicy,
          dailyAutoLimitAtomic: { BTC: '1500', XMR: '0' },
        }),
      } as unknown as SettingsService,
      {} as WalletsService,
      {} as DepositsService,
      {} as AuthService,
      {} as AuditService,
      events,
      {} as AlertsService,
      {} as RedisService,
      {} as CryptoService,
    );

    await expect(service.plan(AssetCode.BTC)).resolves.toEqual(created);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.payoutBatch.aggregate).toHaveBeenCalledOnce();
    expect(tx.payoutBatch.create).toHaveBeenCalledOnce();
    const createInput = tx.payoutBatch.create.mock.calls[0]?.[0] as {
      data: { state: PayoutState; approvalThresholdHit: boolean };
    };
    expect(createInput.data.state).toBe(PayoutState.APPROVAL_REQUIRED);
    expect(createInput.data.approvalThresholdHit).toBe(true);
  });

  it('does not rebroadcast a signed transaction already known by the wallet', async () => {
    const item = {
      id: 'item-1',
      customerId: 'customer-1',
      destination: 'destination',
      grossAtomic: 1000n,
      allocatedFeeAtomic: 10n,
      netAtomic: 990n,
      journalTransactionId: null,
    };
    const batch = {
      id: 'batch-1',
      asset: AssetCode.BTC,
      state: PayoutState.SIGNED,
      signedPayload: 'signed-transaction',
      transactionIds: ['known-txid'],
      items: [item],
    };
    const updateBatch = vi.fn<(input: { data: { state: PayoutState } }) => Promise<void>>();
    updateBatch.mockResolvedValue(undefined);
    const tx = {
      payoutItem: { update: vi.fn().mockResolvedValue(undefined) },
      payoutBatch: { update: updateBatch },
    };
    const prisma = {
      deposit: { findFirst: vi.fn().mockResolvedValue(null) },
      payoutBatch: {
        findUnique: vi.fn().mockResolvedValue(batch),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ ...batch, state: PayoutState.BROADCAST }),
        update: vi.fn().mockResolvedValue(undefined),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx)),
      ),
    } as unknown as PrismaService;
    const wallet = {
      transactionKnown: vi.fn().mockResolvedValue(true),
      broadcast: vi.fn().mockResolvedValue(['known-txid']),
    };
    const postPayout = vi.fn().mockResolvedValue({ id: 'journal-1' });
    const ledger = { postPayout } as unknown as LedgerService;
    const redis = {
      connect: vi.fn().mockResolvedValue(undefined),
      client: {
        set: vi.fn().mockResolvedValue('OK'),
        eval: vi.fn().mockResolvedValue(1),
      },
    } as unknown as RedisService;
    const events = { publish: vi.fn() } as unknown as EventsService;
    const service = new PayoutsService(
      prisma,
      {} as ConfigService<Environment, true>,
      {} as CustomersService,
      ledger,
      {} as SettingsService,
      { forAsset: () => wallet } as unknown as WalletsService,
      {} as DepositsService,
      {} as AuthService,
      {} as AuditService,
      events,
      { raise: vi.fn() } as unknown as AlertsService,
      redis,
      {
        encrypt: vi.fn((value: string) => `v1.encrypted.${value}`),
        decrypt: vi.fn((value: string) => value.replace('v1.encrypted.', '')),
      } as unknown as CryptoService,
    );

    await service.execute(batch.id);

    expect(wallet.transactionKnown).toHaveBeenCalledWith('known-txid');
    expect(wallet.broadcast).not.toHaveBeenCalled();
    expect(postPayout).toHaveBeenCalledOnce();
    expect(updateBatch).toHaveBeenCalledOnce();
    expect(updateBatch.mock.calls[0]?.[0].data.state).toBe(PayoutState.BROADCAST);
  });

  it('encrypts a newly prepared payload at rest and decrypts it only for broadcast', async () => {
    const item = {
      id: 'item-new',
      customerId: 'customer-new',
      destination: 'destination-new',
      grossAtomic: 1_000n,
      allocatedFeeAtomic: 0n,
      netAtomic: 1_000n,
      journalTransactionId: null,
    };
    const initialBatch = {
      id: 'batch-new',
      asset: AssetCode.BTC,
      kind: PayoutKind.CUSTOMER,
      state: PayoutState.AUTO_APPROVED,
      totalGrossAtomic: 1_000n,
      policySnapshot: { feePayer: NetworkFeePayer.OPERATOR, maxFeeBps: 200 },
      signedPayload: null,
      transactionIds: [] as string[],
      items: [item],
    };
    const signedBatch = {
      ...initialBatch,
      state: PayoutState.SIGNED,
      signedPayload: 'v1.encrypted-payload',
      transactionIds: ['prepared-txid'],
      items: [{ ...item, allocatedFeeAtomic: 10n, netAtomic: 1_000n }],
    };
    const broadcastBatch = { ...signedBatch, state: PayoutState.BROADCAST };
    const updateBatch = vi
      .fn<(input: { data: Record<string, unknown> }) => Promise<void>>()
      .mockResolvedValue(undefined);
    const tx = {
      payoutItem: { update: vi.fn().mockResolvedValue(undefined) },
      payoutBatch: { update: updateBatch },
    };
    const prisma = {
      deposit: { findFirst: vi.fn().mockResolvedValue(null) },
      payoutBatch: {
        findUnique: vi.fn().mockResolvedValue(initialBatch),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValueOnce(signedBatch)
          .mockResolvedValueOnce(broadcastBatch),
        update: vi.fn().mockResolvedValue(undefined),
      },
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) =>
        Promise.resolve(callback(tx)),
      ),
    } as unknown as PrismaService;
    const wallet = {
      preparePayout: vi.fn().mockResolvedValue({
        signedPayload: 'wallet-secret-payload',
        transactionIds: ['prepared-txid'],
        feeAtomic: 10n,
        items: [{ id: item.id, allocatedFeeAtomic: 10n, netAtomic: 1_000n }],
      }),
      transactionKnown: vi.fn().mockResolvedValue(false),
      broadcast: vi.fn().mockResolvedValue(['broadcast-txid']),
    };
    const crypto = {
      encrypt: vi.fn().mockReturnValue('v1.encrypted-payload'),
      decrypt: vi.fn().mockReturnValue('wallet-secret-payload'),
    };
    const redis = {
      connect: vi.fn().mockResolvedValue(undefined),
      client: {
        set: vi.fn().mockResolvedValue('OK'),
        eval: vi.fn().mockResolvedValue(1),
      },
    } as unknown as RedisService;
    const postPayout = vi.fn().mockResolvedValue({ id: 'journal-new' });
    const ledger = { postPayout } as unknown as LedgerService;
    const service = new PayoutsService(
      prisma,
      {} as ConfigService<Environment, true>,
      {} as CustomersService,
      ledger,
      { payoutPolicy: vi.fn().mockResolvedValue(payoutPolicy) } as unknown as SettingsService,
      { forAsset: () => wallet } as unknown as WalletsService,
      {} as DepositsService,
      {} as AuthService,
      {} as AuditService,
      { publish: vi.fn() } as unknown as EventsService,
      { raise: vi.fn() } as unknown as AlertsService,
      redis,
      crypto as unknown as CryptoService,
    );

    await service.execute(initialBatch.id);

    expect(crypto.encrypt).toHaveBeenCalledWith(
      'wallet-secret-payload',
      'payout:batch-new:signed-payload',
    );
    expect(updateBatch.mock.calls[1]?.[0].data).not.toHaveProperty('signedPayload');
    expect(crypto.decrypt).toHaveBeenCalledWith(
      'v1.encrypted-payload',
      'payout:batch-new:signed-payload',
    );
    expect(wallet.broadcast).toHaveBeenCalledWith('wallet-secret-payload');
    expect(wallet.preparePayout).toHaveBeenCalledWith(
      [{ id: item.id, address: item.destination, grossAtomic: item.grossAtomic }],
      { deductFeeFromOutputs: false },
    );
    expect(postPayout).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operatorPaysFee: true }),
    );
  });
});
