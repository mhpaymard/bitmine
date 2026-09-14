import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AlertSeverity,
  AssetCode,
  DestinationStatus,
  EntityStatus,
  LedgerAccountType,
} from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { AuditService } from '../audit/audit.service';
import type { Environment } from '../config/environment';
import { isValidIpRule } from '../common/ip-rules';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { WalletsService } from '../wallets/wallets.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import type {
  CreateCustomerDto,
  CreatePayoutDestinationDto,
  CreateSplitPolicyDto,
  CreateWorkerDto,
  RotateCredentialDto,
  UpdateCustomerDto,
} from './dto/customers.dto';

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Environment, true>,
    private readonly wallets: WalletsService,
    private readonly alerts: AlertsService,
  ) {}

  list() {
    return this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { workers: true } },
        splitPolicies: { orderBy: { effectiveAt: 'desc' }, distinct: ['asset'] },
      },
    });
  }

  async get(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: {
        workers: {
          include: {
            credentials: {
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                tokenPrefix: true,
                activeFrom: true,
                expiresAt: true,
                revokedAt: true,
                createdAt: true,
              },
            },
          },
        },
        splitPolicies: { orderBy: { effectiveAt: 'desc' } },
        payoutDestinations: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  async create(dto: CreateCustomerDto, actor: AuthenticatedAdmin) {
    try {
      const customer = await this.prisma.$transaction(async (tx) => {
        const created = await tx.customer.create({ data: dto });
        await tx.splitPolicyVersion.createMany({
          data: [AssetCode.BTC, AssetCode.XMR].map((asset) => ({
            customerId: created.id,
            asset,
            customerBps: 8000,
            operatorBps: 2000,
            effectiveAt: new Date(),
            createdById: actor.id,
          })),
        });
        await tx.ledgerAccount.createMany({
          data: [AssetCode.BTC, AssetCode.XMR].map((asset) => ({
            asset,
            customerId: created.id,
            code: `customer:${created.id}:liability`,
            name: `${created.displayName} liability`,
            type: LedgerAccountType.LIABILITY,
          })),
        });
        return created;
      });
      await this.audit.record({
        actorId: actor.id,
        action: 'CUSTOMER_CREATED',
        entityType: 'Customer',
        entityId: customer.id,
        after: customer,
      });
      return customer;
    } catch (error) {
      if (String(error).includes('Unique constraint'))
        throw new ConflictException('Customer slug already exists');
      throw error;
    }
  }

  async update(id: string, dto: UpdateCustomerDto, actor: AuthenticatedAdmin) {
    const before = await this.get(id);
    const customer = await this.prisma.customer.update({ where: { id }, data: dto });
    await this.audit.record({
      actorId: actor.id,
      action: 'CUSTOMER_UPDATED',
      entityType: 'Customer',
      entityId: id,
      before,
      after: customer,
    });
    return customer;
  }

  async setStatus(id: string, status: EntityStatus, actor: AuthenticatedAdmin) {
    const before = await this.prisma.customer.findUniqueOrThrow({ where: { id } });
    const customer = await this.prisma.customer.update({ where: { id }, data: { status } });
    await this.audit.record({
      actorId: actor.id,
      action: 'CUSTOMER_STATUS_CHANGED',
      entityType: 'Customer',
      entityId: id,
      before,
      after: customer,
    });
    return customer;
  }

  async createWorker(customerId: string, dto: CreateWorkerDto, actor: AuthenticatedAdmin) {
    await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const invalidIpRule = dto.allowedIps?.find((rule) => !isValidIpRule(rule));
    if (invalidIpRule) throw new BadRequestException(`Invalid worker IP rule: ${invalidIpRule}`);
    const token = this.crypto.randomToken(32);
    const tokenHash = await this.crypto.hashSecret(token);
    const worker = await this.prisma.worker.create({
      data: {
        customerId,
        slug: dto.slug,
        asset: dto.asset,
        maxConnections: dto.maxConnections ?? 1,
        allowedIps: dto.allowedIps ?? [],
        credentials: { create: { tokenHash, tokenPrefix: token.slice(0, 10) } },
      },
      include: { customer: true },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'WORKER_CREATED',
      entityType: 'Worker',
      entityId: worker.id,
      after: { ...worker, tokenPrefix: token.slice(0, 10) },
    });
    return {
      worker,
      credentials: {
        username: `${worker.customer.slug}.${worker.slug}`,
        password: token,
        shownOnce: true,
      },
    };
  }

  async rotateCredential(workerId: string, dto: RotateCredentialDto, actor: AuthenticatedAdmin) {
    const worker = await this.prisma.worker.findUnique({
      where: { id: workerId },
      include: { customer: true },
    });
    if (!worker) throw new NotFoundException('Worker not found');
    const token = this.crypto.randomToken(32);
    const tokenHash = await this.crypto.hashSecret(token);
    const graceMinutes = dto.graceMinutes ?? 10;
    const expiresAt = new Date(Date.now() + graceMinutes * 60_000);
    await this.prisma.$transaction([
      this.prisma.workerCredential.updateMany({
        where: { workerId, revokedAt: null, expiresAt: null },
        data: { expiresAt },
      }),
      this.prisma.workerCredential.create({
        data: { workerId, tokenHash, tokenPrefix: token.slice(0, 10) },
      }),
    ]);
    await this.audit.record({
      actorId: actor.id,
      action: 'WORKER_CREDENTIAL_ROTATED',
      entityType: 'Worker',
      entityId: workerId,
      after: { graceMinutes, tokenPrefix: token.slice(0, 10) },
    });
    return {
      username: `${worker.customer.slug}.${worker.slug}`,
      password: token,
      shownOnce: true,
      oldCredentialExpiresAt: expiresAt,
    };
  }

  async revokeCredential(credentialId: string, actor: AuthenticatedAdmin) {
    const credential = await this.prisma.workerCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'WORKER_CREDENTIAL_REVOKED',
      entityType: 'WorkerCredential',
      entityId: credentialId,
    });
    return credential;
  }

  async createPolicy(customerId: string, dto: CreateSplitPolicyDto, actor: AuthenticatedAdmin) {
    const operatorBps = 10_000 - dto.customerBps;
    if (operatorBps < 0) throw new BadRequestException('Split total must equal 10000 basis points');
    const policy = await this.prisma.splitPolicyVersion.create({
      data: {
        customerId,
        asset: dto.asset,
        customerBps: dto.customerBps,
        operatorBps,
        effectiveAt: dto.effectiveAt ? new Date(dto.effectiveAt) : new Date(),
        createdById: actor.id,
      },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'SPLIT_POLICY_CREATED',
      entityType: 'SplitPolicyVersion',
      entityId: policy.id,
      after: policy,
    });
    return policy;
  }

  async createDestination(
    customerId: string,
    dto: CreatePayoutDestinationDto,
    actor: AuthenticatedAdmin,
  ) {
    await this.get(customerId);
    const address = dto.address.trim();
    if (!(await this.wallets.forAsset(dto.asset).validateAddress(address))) {
      throw new BadRequestException('Invalid payout address for selected asset');
    }
    const defaultMinimum =
      dto.asset === AssetCode.BTC
        ? this.config.get('BITCOIN_MIN_PAYOUT_ATOMIC', { infer: true })
        : this.config.get('MONERO_MIN_PAYOUT_ATOMIC', { infer: true });
    const effectiveAt = new Date(Date.now() + 24 * 60 * 60_000);
    const destination = await this.prisma.payoutDestination.create({
      data: {
        customerId,
        asset: dto.asset,
        address,
        status: DestinationStatus.PENDING,
        effectiveAt,
        minPayoutAtomic: dto.minPayoutAtomic ? BigInt(dto.minPayoutAtomic) : defaultMinimum,
      },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'PAYOUT_DESTINATION_CREATED',
      entityType: 'PayoutDestination',
      entityId: destination.id,
      after: destination,
    });
    await this.alerts.raise({
      dedupeKey: `payout-destination:${customerId}:${dto.asset}`,
      severity: AlertSeverity.WARNING,
      title: `${dto.asset} payout destination is pending`,
      message: `A customer payout address change is cooling until ${effectiveAt.toISOString()}`,
      metadata: {
        customerId,
        destinationId: destination.id,
        effectiveAt: effectiveAt.toISOString(),
      },
    });
    return destination;
  }

  async activateDueDestinations(): Promise<number> {
    const due = await this.prisma.payoutDestination.findMany({
      where: { status: DestinationStatus.PENDING, effectiveAt: { lte: new Date() } },
    });
    for (const destination of due) {
      await this.prisma.$transaction([
        this.prisma.payoutDestination.updateMany({
          where: {
            customerId: destination.customerId,
            asset: destination.asset,
            status: DestinationStatus.ACTIVE,
          },
          data: { status: DestinationStatus.REVOKED, revokedAt: new Date() },
        }),
        this.prisma.payoutDestination.update({
          where: { id: destination.id },
          data: { status: DestinationStatus.ACTIVE },
        }),
      ]);
      await this.alerts.resolveByDedupe(
        `payout-destination:${destination.customerId}:${destination.asset}`,
      );
    }
    return due.length;
  }
}
