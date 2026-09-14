import { Injectable } from '@nestjs/common';
import { AssetCode, EntityStatus } from '@prisma/client';
import type { AuthorizedWorker } from './gateway.types';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CryptoService } from '../security/crypto.service';
import { ipAllowed } from '../common/ip-rules';

@Injectable()
export class GatewayAuthService {
  private readonly leaseMs = 180_000;
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
  ) {}

  async authenticate(
    asset: AssetCode,
    username: string,
    password: string,
    remoteIp: string,
  ): Promise<AuthorizedWorker | null> {
    const separator = username.indexOf('.');
    if (separator < 1) return null;
    const customerSlug = username.slice(0, separator).toLowerCase();
    const workerSlug = username.slice(separator + 1);
    const worker = await this.prisma.worker.findFirst({
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
    if (!worker || !ipAllowed(remoteIp, worker.allowedIps)) return null;
    let valid = false;
    for (const credential of worker.credentials) {
      if (await this.crypto.verifySecret(credential.tokenHash, password)) {
        valid = true;
        break;
      }
    }
    if (!valid) return null;
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
    return { worker, customer: worker.customer, policy, connectionLeaseId };
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

  private connectionKey(workerId: string): string {
    return `gateway:connections:${workerId}`;
  }
}
