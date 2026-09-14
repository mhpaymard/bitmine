import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AssetCode, Upstream } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { connectUpstream } from '../gateway/socket-connect';
import { WalletsService } from '../wallets/wallets.service';
import type { CreateUpstreamDto, UpdateUpstreamDto } from './dto/upstreams.dto';

@Injectable()
export class UpstreamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly wallets: WalletsService,
  ) {}

  list(asset?: AssetCode) {
    return this.prisma.upstream.findMany({
      where: asset ? { asset } : undefined,
      orderBy: [{ asset: 'asc' }, { priority: 'asc' }],
      select: {
        id: true,
        accountKey: true,
        asset: true,
        protocol: true,
        name: true,
        host: true,
        port: true,
        tls: true,
        priority: true,
        enabled: true,
        usernameTemplate: true,
        receiveAddress: true,
        lastHealthAt: true,
        lastHealthOk: true,
        lastHealthMessage: true,
        connectionTimeoutMs: true,
        failbackCooldownSeconds: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async create(dto: CreateUpstreamDto, actor: AuthenticatedAdmin) {
    const bitcoinProtocol = dto.protocol === 'BITCOIN_STRATUM_V1' && dto.asset === 'BTC';
    const moneroProtocol = dto.protocol === 'MONERO_JSON_RPC' && dto.asset === 'XMR';
    if (!bitcoinProtocol && !moneroProtocol)
      throw new BadRequestException('Protocol does not match asset');
    if (
      dto.receiveAddress &&
      !(await this.wallets.forAsset(dto.asset).validateAddress(dto.receiveAddress))
    ) {
      throw new BadRequestException('Invalid receive address for upstream asset');
    }
    const id = randomUUID();
    const accountKey = dto.accountKey ?? id;
    const peer = dto.accountKey
      ? await this.prisma.upstream.findFirst({ where: { asset: dto.asset, accountKey } })
      : null;
    if (peer && peer.protocol !== dto.protocol)
      throw new BadRequestException('Pool-account endpoints must use the same protocol');
    if (peer && peer.receiveAddress !== (dto.receiveAddress ?? null))
      throw new BadRequestException('Pool-account endpoints must use the same receive address');
    if (peer && peer.usernameTemplate !== dto.usernameTemplate)
      throw new BadRequestException('Pool-account endpoints must use the same username template');
    if (peer && (dto.password ?? 'x') !== this.password(peer))
      throw new BadRequestException('Pool-account endpoints must use the same password');
    const upstream = await this.prisma.upstream.create({
      data: {
        id,
        accountKey,
        asset: dto.asset,
        protocol: dto.protocol,
        name: dto.name,
        host: dto.host,
        port: dto.port,
        tls: dto.tls,
        priority: dto.priority,
        usernameTemplate: dto.usernameTemplate,
        passwordCiphertext: peer
          ? peer.passwordCiphertext
            ? this.crypto.encrypt(this.password(peer), `upstream:${id}:password`)
            : null
          : dto.password
            ? this.crypto.encrypt(dto.password, `upstream:${id}:password`)
            : null,
        receiveAddress: dto.receiveAddress,
      },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'UPSTREAM_CREATED',
      entityType: 'Upstream',
      entityId: id,
      after: this.safe(upstream),
    });
    return this.safe(upstream);
  }

  async update(id: string, dto: UpdateUpstreamDto, actor: AuthenticatedAdmin) {
    const before = await this.prisma.upstream.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Upstream not found');
    if (
      dto.receiveAddress &&
      dto.receiveAddress !== before.receiveAddress &&
      !(await this.wallets.forAsset(before.asset).validateAddress(dto.receiveAddress))
    ) {
      throw new BadRequestException('Invalid receive address for upstream asset');
    }
    const nextAccountKey = dto.accountKey ?? before.accountKey;
    const peers = await this.prisma.upstream.findMany({
      where: { asset: before.asset, accountKey: nextAccountKey, id: { not: id } },
    });
    const nextAddress =
      dto.receiveAddress === undefined ? before.receiveAddress : dto.receiveAddress;
    const nextTemplate = dto.usernameTemplate ?? before.usernameTemplate;
    const joiningExistingAccount = nextAccountKey !== before.accountKey;
    if (joiningExistingAccount && peers.some((peer) => peer.receiveAddress !== nextAddress))
      throw new BadRequestException('Pool-account endpoints must use the same receive address');
    if (joiningExistingAccount && peers.some((peer) => peer.usernameTemplate !== nextTemplate))
      throw new BadRequestException('Pool-account endpoints must use the same username template');
    const nextPassword = dto.password === undefined ? this.password(before) : dto.password || 'x';
    if (joiningExistingAccount && peers.some((peer) => this.password(peer) !== nextPassword))
      throw new BadRequestException('Pool-account endpoints must use the same password');
    const upstream = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.upstream.update({
        where: { id },
        data: {
          accountKey: dto.accountKey,
          name: dto.name,
          host: dto.host,
          port: dto.port,
          tls: dto.tls,
          priority: dto.priority,
          enabled: dto.enabled,
          usernameTemplate: dto.usernameTemplate,
          receiveAddress: dto.receiveAddress,
          ...(dto.password !== undefined
            ? {
                passwordCiphertext: dto.password
                  ? this.crypto.encrypt(dto.password, `upstream:${id}:password`)
                  : null,
              }
            : {}),
        },
      });
      if (!joiningExistingAccount) {
        for (const peer of peers) {
          await tx.upstream.update({
            where: { id: peer.id },
            data: {
              usernameTemplate: dto.usernameTemplate,
              receiveAddress: dto.receiveAddress,
              ...(dto.password !== undefined
                ? {
                    passwordCiphertext: dto.password
                      ? this.crypto.encrypt(dto.password, `upstream:${peer.id}:password`)
                      : null,
                  }
                : {}),
            },
          });
        }
      }
      return updated;
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'UPSTREAM_UPDATED',
      entityType: 'Upstream',
      entityId: id,
      before: this.safe(before),
      after: this.safe(upstream),
    });
    return this.safe(upstream);
  }

  async test(id: string): Promise<{ ok: boolean; latencyMs: number; message: string }> {
    const upstream = await this.prisma.upstream.findUnique({ where: { id } });
    if (!upstream) throw new NotFoundException('Upstream not found');
    const started = performance.now();
    try {
      await this.protocolProbe(upstream);
      const latencyMs = Math.round(performance.now() - started);
      const message = 'Stratum protocol and authentication successful';
      await this.prisma.upstream.update({
        where: { id },
        data: {
          lastHealthAt: new Date(),
          lastHealthOk: true,
          lastHealthMessage: message,
        },
      });
      return { ok: true, latencyMs, message };
    } catch (error) {
      const latencyMs = Math.round(performance.now() - started);
      const message = error instanceof Error ? error.message : 'Unknown connection error';
      await this.prisma.upstream.update({
        where: { id },
        data: { lastHealthAt: new Date(), lastHealthOk: false, lastHealthMessage: message },
      });
      return { ok: false, latencyMs, message };
    }
  }

  private async protocolProbe(upstream: Upstream): Promise<void> {
    const socket = await connectUpstream(upstream);
    let buffer = '';
    let nextId = 1;
    const waiters = new Map<
      number,
      {
        resolve: (message: Record<string, unknown>) => void;
        reject: (error: Error) => void;
        timeout: NodeJS.Timeout;
      }
    >();
    const rejectAll = (error: Error) => {
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      waiters.clear();
    };
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (typeof message.id !== 'number') continue;
          const waiter = waiters.get(message.id);
          if (!waiter) continue;
          waiters.delete(message.id);
          clearTimeout(waiter.timeout);
          waiter.resolve(message);
        } catch {
          rejectAll(new Error('Upstream returned invalid JSON'));
          socket.destroy();
        }
      }
    });
    socket.once('error', (error) => rejectAll(error));
    socket.once('close', () => rejectAll(new Error('Upstream closed the health-check connection')));

    const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`Upstream ${method} response timed out`));
          socket.destroy();
        }, upstream.connectionTimeoutMs);
        waiters.set(id, { resolve, reject, timeout });
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    };

    try {
      const username = this.renderUsername(upstream, 'health', 'probe');
      const password = this.password(upstream);
      if (upstream.protocol === 'BITCOIN_STRATUM_V1') {
        const subscribed = await request('mining.subscribe', ['mitm-health/1.0']);
        if (subscribed.error || !Array.isArray(subscribed.result))
          throw new Error('Bitcoin Stratum subscribe failed');
        const authorized = await request('mining.authorize', [username, password]);
        if (authorized.error || authorized.result !== true)
          throw new Error('Bitcoin Stratum authentication failed');
      } else {
        const login = await request('login', {
          login: username,
          pass: password,
          agent: 'mitm-health/1.0',
        });
        const result = login.result as { id?: unknown; status?: unknown } | undefined;
        if (login.error || !result?.id || result.status !== 'OK')
          throw new Error('Monero pool authentication failed');
      }
    } finally {
      socket.destroy();
      rejectAll(new Error('Health check completed'));
    }
  }

  async candidates(asset: AssetCode, excludeIds: string[] = []): Promise<Upstream[]> {
    return this.prisma.upstream.findMany({
      where: { asset, enabled: true, id: { notIn: excludeIds } },
      orderBy: [{ priority: 'asc' }, { lastHealthOk: 'desc' }],
    });
  }

  password(upstream: Upstream): string {
    return upstream.passwordCiphertext
      ? this.crypto.decrypt(upstream.passwordCiphertext, `upstream:${upstream.id}:password`)
      : 'x';
  }

  renderUsername(upstream: Upstream, customerSlug: string, workerSlug: string): string {
    return upstream.usernameTemplate
      .replaceAll('{customer}', customerSlug)
      .replaceAll('{worker}', workerSlug)
      .replaceAll('{username}', `${customerSlug}.${workerSlug}`);
  }

  private safe(
    upstream: Upstream,
  ): Omit<Upstream, 'passwordCiphertext'> & { hasPassword: boolean } {
    const { passwordCiphertext, ...rest } = upstream;
    return { ...rest, hasPassword: Boolean(passwordCiphertext) };
  }
}
