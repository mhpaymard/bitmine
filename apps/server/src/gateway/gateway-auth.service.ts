import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AssetCode,
  type Customer,
  EntityStatus,
  LedgerAccountType,
  type Worker,
} from '@prisma/client';
import type { AuthorizedWorker } from './gateway.types';
import { AuditService } from '../audit/audit.service';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CryptoService } from '../security/crypto.service';
import { ipAllowed } from '../common/ip-rules';

type ActiveWorker = Worker & {
  customer: Customer;
  credentials: { tokenHash: string }[];
};

type ProvisionedWorker = Worker & { customer: Customer };

@Injectable()
export class GatewayAuthService {
  private readonly leaseMs = 180_000;
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
  ) {}

  async authenticate(
    asset: AssetCode,
    username: string,
    password: string,
    remoteIp: string,
  ): Promise<AuthorizedWorker | null> {
    const parsed = this.parseUsername(username);
    if (!parsed) return null;
    const { customerSlug, workerSlug } = parsed;

    const worker = await this.findActiveWorker(asset, customerSlug, workerSlug);

    if (worker) {
      if (!ipAllowed(remoteIp, worker.allowedIps)) return null;
      let valid = false;
      for (const credential of worker.credentials) {
        if (await this.crypto.verifySecret(credential.tokenHash, password)) {
          valid = true;
          break;
        }
      }
      if (!valid) return null;
      return this.finalize(worker, worker.customer, asset);
    }

    if (!this.config.get('GATEWAY_AUTO_PROVISION_ENABLED', { infer: true })) return null;
    const provisioned = await this.autoProvision(
      asset,
      customerSlug,
      workerSlug,
      password,
      remoteIp,
    );
    if (!provisioned) return null;
    return this.finalize(provisioned, provisioned.customer, asset);
  }

  async renewConnection(workerId: string, leaseId: string): Promise<boolean> {
    const result = Number(
      await this.redis.client.eval(
        `if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
         redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
         redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
         return 1`,
        1,
        this.connectionKey(workerId),
        leaseId,
        Date.now() + this.leaseMs,
        this.leaseMs * 2,
      ),
    );
    return result === 1;
  }

  async connectionClosed(workerId: string, leaseId: string): Promise<void> {
    const key = this.connectionKey(workerId);
    await this.redis.client.zrem(key, leaseId);
    if ((await this.redis.client.zcard(key)) === 0) await this.redis.client.del(key);
  }

  /**
   * "customer.worker" is the normal shape. With auto-provisioning enabled, a
   * bare username (no dot) is also accepted so brand-new hardware with a
   * factory-default worker name can still claim an identity on first connect.
   */
  private parseUsername(username: string): { customerSlug: string; workerSlug: string } | null {
    const separator = username.indexOf('.');
    if (separator > 0) {
      return {
        customerSlug: username.slice(0, separator).toLowerCase(),
        workerSlug: username.slice(separator + 1),
      };
    }
    if (!this.config.get('GATEWAY_AUTO_PROVISION_ENABLED', { infer: true })) return null;
    const trimmed = username.trim().toLowerCase();
    if (!trimmed) return null;
    return { customerSlug: trimmed, workerSlug: 'default' };
  }

  private async findActiveWorker(
    asset: AssetCode,
    customerSlug: string,
    workerSlug: string,
  ): Promise<ActiveWorker | null> {
    return this.prisma.worker.findFirst({
      where: {
        asset,
        slug: workerSlug,
        status: EntityStatus.ACTIVE,
        customer: { slug: customerSlug, status: EntityStatus.ACTIVE },
      },
      include: {
        customer: true,
        credentials: {
          where: {
            revokedAt: null,
            activeFrom: { lte: new Date() },
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
  }

  /**
   * Creates the customer (if this is a brand-new slug) and the worker on
   * first connect, claiming that "customer.worker" identity with whatever
   * password the miner presented (including a blank one). Once claimed, the
   * normal credential check above protects the identity from being taken
   * over by a different device.
   */
  private async autoProvision(
    asset: AssetCode,
    customerSlugRaw: string,
    workerSlugRaw: string,
    password: string,
    remoteIp: string,
  ): Promise<ProvisionedWorker | null> {
    if (!(await this.autoProvisionRateOk(remoteIp))) return null;

    const customerSlug = this.sanitizeCustomerSlug(customerSlugRaw);
    const workerSlug = this.sanitizeWorkerSlug(workerSlugRaw);
    const customerBps = this.config.get('GATEWAY_AUTO_PROVISION_CUSTOMER_BPS', { infer: true });
    const maxConnections = this.config.get('GATEWAY_AUTO_PROVISION_MAX_CONNECTIONS', {
      infer: true,
    });
    const tokenHash = await this.crypto.hashSecret(password);
    const tokenPrefix = password ? password.slice(0, 10) : 'auto-claimed';

    try {
      const worker = await this.prisma.$transaction(async (tx) => {
        const customer =
          (await tx.customer.findUnique({ where: { slug: customerSlug } })) ??
          (await (async () => {
            const created = await tx.customer.create({
              data: { slug: customerSlug, displayName: customerSlug },
            });
            await tx.splitPolicyVersion.createMany({
              data: [AssetCode.BTC, AssetCode.XMR].map((a) => ({
                customerId: created.id,
                asset: a,
                customerBps,
                operatorBps: 10_000 - customerBps,
                effectiveAt: new Date(),
              })),
            });
            await tx.ledgerAccount.createMany({
              data: [AssetCode.BTC, AssetCode.XMR].map((a) => ({
                asset: a,
                customerId: created.id,
                code: `customer:${created.id}:liability`,
                name: `${created.displayName} liability`,
                type: LedgerAccountType.LIABILITY,
              })),
            });
            return created;
          })());
        if (customer.status !== EntityStatus.ACTIVE) throw new AutoProvisionDenied();

        const existingWorker = await tx.worker.findUnique({
          where: { customerId_asset_slug: { customerId: customer.id, asset, slug: workerSlug } },
        });
        if (existingWorker) throw new AutoProvisionDenied();

        return tx.worker.create({
          data: {
            customerId: customer.id,
            asset,
            slug: workerSlug,
            maxConnections,
            allowedIps: [],
            credentials: { create: { tokenHash, tokenPrefix } },
          },
          include: { customer: true },
        });
      });

      await this.audit.record({
        action: 'GATEWAY_AUTO_PROVISIONED',
        entityType: 'Worker',
        entityId: worker.id,
        ipAddress: remoteIp,
        after: {
          customerSlug: worker.customer.slug,
          workerSlug: worker.slug,
          asset,
          maxConnections,
        },
      });
      return worker;
    } catch (error) {
      if (error instanceof AutoProvisionDenied) return null;
      if (String(error).includes('Unique constraint')) return null;
      throw error;
    }
  }

  private async autoProvisionRateOk(remoteIp: string): Promise<boolean> {
    const limit = this.config.get('GATEWAY_AUTO_PROVISION_MAX_PER_IP_PER_HOUR', { infer: true });
    await this.redis.connect();
    const key = `gateway:autoprovision:${this.crypto.sha256(remoteIp)}`;
    const attempts = await this.redis.client.incr(key);
    if (attempts === 1) await this.redis.client.expire(key, 3600);
    return attempts <= limit;
  }

  private sanitizeCustomerSlug(raw: string): string {
    const cleaned = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]+/gu, '-')
      .replace(/-{2,}/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 48)
      .replace(/-+$/gu, '');
    if (cleaned.length >= 3) return cleaned;
    const base = cleaned || 'rig';
    return `${base}-${randomBytes(4).toString('hex')}`.slice(0, 48);
  }

  private sanitizeWorkerSlug(raw: string): string {
    const cleaned = raw
      .replace(/[^a-zA-Z0-9_-]+/gu, '-')
      .replace(/^[^a-zA-Z0-9]+/u, '')
      .slice(0, 64);
    return cleaned || 'default';
  }

  private async finalize(
    worker: Worker,
    customer: Customer,
    asset: AssetCode,
  ): Promise<AuthorizedWorker | null> {
    const policy = await this.prisma.splitPolicyVersion.findFirst({
      where: { customerId: worker.customerId, asset, effectiveAt: { lte: new Date() } },
      orderBy: { effectiveAt: 'desc' },
    });
    if (!policy) return null;
    await this.redis.connect();
    const connectionLeaseId = this.crypto.randomToken(18);
    const acquired = Number(
      await this.redis.client.eval(
        `local now = tonumber(ARGV[1])
         redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
         if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
         redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[4])
         redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5]))
         return 1`,
        1,
        this.connectionKey(worker.id),
        Date.now(),
        Date.now() + this.leaseMs,
        worker.maxConnections,
        connectionLeaseId,
        this.leaseMs * 2,
      ),
    );
    if (acquired !== 1) return null;
    return { worker, customer, policy, connectionLeaseId };
  }

  private connectionKey(workerId: string): string {
    return `gateway:connections:${workerId}`;
  }
}

class AutoProvisionDenied extends Error {}
