import type { Socket } from 'node:net';
import { AssetCode } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import type { PrismaService } from '../database/prisma.service';
import type { EventsService } from '../events/events.service';
import type { ProxyHealthService } from '../network/proxy-health.service';
import type { UpstreamsService } from '../upstreams/upstreams.service';
import type { GatewayAuthService } from './gateway-auth.service';
import type {
  AuthorizedWorker,
  JsonRpcMessage,
  PendingRpc,
  UpstreamBinding,
} from './gateway.types';
import { LineJsonPeer } from './line-json-peer';
import type { ShareJournalService } from './share-journal.service';
import { connectUpstream } from './socket-connect';
import type { UpstreamRuntimeService } from './upstream-runtime.service';

export interface BitcoinSessionDependencies {
  config: ConfigService<Environment, true>;
  authService: GatewayAuthService;
  journal: ShareJournalService;
  upstreams: UpstreamsService;
  runtime: UpstreamRuntimeService;
  prisma: PrismaService;
  events: EventsService;
  proxyHealth: ProxyHealthService;
}

export class BitcoinGatewaySession {
  private readonly downstream: LineJsonPeer;
  private upstream?: LineJsonPeer;
  private binding?: UpstreamBinding;
  private authorized?: AuthorizedWorker;
  private connectionId?: string;
  private difficulty = '1';
  private nextId = 1;
  private readonly pending = new Map<string, PendingRpc>();
  private closing = false;
  private countedConnection = false;
  private leaseTimer?: NodeJS.Timeout;
  private clientAgent?: string;
  private readonly authTimer: NodeJS.Timeout;

  constructor(
    private readonly socket: Socket,
    private readonly deps: BitcoinSessionDependencies,
  ) {
    const maxLine = deps.config.get('GATEWAY_MAX_LINE_BYTES', { infer: true });
    this.downstream = new LineJsonPeer(
      socket,
      maxLine,
      (message) => this.onDownstream(message),
      (error) => {
        void this.close(`protocol:${error.message}`);
      },
    );
    socket.setTimeout(deps.config.get('GATEWAY_IDLE_TIMEOUT_MS', { infer: true }), () => {
      void this.close('idle-timeout');
    });
    socket.setKeepAlive(true, 30_000);
    socket.setNoDelay(true);
    socket.once('close', () => void this.close('downstream-closed'));
    socket.once('error', () => undefined);
    this.authTimer = setTimeout(
      () => void this.close('authorization-timeout'),
      deps.config.get('GATEWAY_AUTH_TIMEOUT_MS', { infer: true }),
    );
    this.authTimer.unref();
  }

  private remoteIp(): string {
    return this.socket.remoteAddress?.replace(/^::ffff:/u, '') ?? 'unknown';
  }

  private async ensureUpstream(): Promise<void> {
    if (this.upstream) return;
    const candidates = await this.deps.runtime.candidates(AssetCode.BTC);
    let lastError: unknown = new Error('No Bitcoin upstream is enabled');
    for (const upstream of candidates) {
      try {
        const proxy = await this.deps.proxyHealth.resolveGatewayProxy();
        const socket = await connectUpstream(upstream, proxy);
        this.binding = {
          upstream,
          username: '',
          password: this.deps.upstreams.password(upstream),
        };
        this.upstream = new LineJsonPeer(
          socket,
          this.deps.config.get('GATEWAY_MAX_LINE_BYTES', { infer: true }),
          (message) => this.onUpstream(message),
          (error) => {
            void this.close(`upstream-protocol:${error.message}`, true);
          },
        );
        socket.once('close', () => {
          if (!this.closing) void this.upstreamFailed(new Error('Upstream disconnected'));
        });
        socket.once('error', (error) => {
          if (!this.closing) void this.upstreamFailed(error);
        });
        await this.deps.runtime.success(upstream);
        return;
      } catch (error) {
        lastError = error;
        await this.deps.runtime.failure(upstream, error);
      }
    }
    throw lastError;
  }

  private async onDownstream(message: JsonRpcMessage): Promise<void> {
    if (!message.method) return;
    if (message.method === 'mining.authorize') {
      await this.authorize(message);
      return;
    }
    if (message.method === 'mining.submit') {
      await this.submit(message);
      return;
    }
    if (
      message.method === 'mining.subscribe' &&
      Array.isArray(message.params) &&
      typeof message.params[0] === 'string'
    ) {
      this.clientAgent = message.params[0];
    }
    const allowed = new Set([
      'mining.subscribe',
      'mining.configure',
      'mining.extranonce.subscribe',
      'mining.suggest_difficulty',
    ]);
    if (!allowed.has(message.method)) {
      this.downstream.send({
        id: message.id ?? null,
        result: null,
        error: [20, 'Unsupported method', message.method],
      });
      return;
    }
    await this.forward(message, message.method);
  }

  private async authorize(message: JsonRpcMessage): Promise<void> {
    const params = Array.isArray(message.params) ? message.params : [];
    const username = typeof params[0] === 'string' ? params[0] : '';
    const password = typeof params[1] === 'string' ? params[1] : '';
    const authorized = await this.deps.authService.authenticate(
      AssetCode.BTC,
      username,
      password,
      this.remoteIp(),
    );
    if (!authorized) {
      this.downstream.send({
        id: message.id ?? null,
        result: false,
        error: [24, 'Local authorization failed', null],
      });
      void this.close('authorization-failed');
      return;
    }
    this.authorized = authorized;
    this.socket.emit('gateway:authorized');
    clearTimeout(this.authTimer);
    this.countedConnection = true;
    this.startLeaseHeartbeat();
    await this.ensureUpstream();
    if (!this.binding || !this.upstream) throw new Error('Bitcoin upstream is unavailable');
    this.binding.username = this.deps.upstreams.renderUsername(
      this.binding.upstream,
      authorized.customer.slug,
      authorized.worker.slug,
    );
    const connection = await this.deps.journal.createConnection(
      authorized,
      this.binding.upstream.id,
      this.remoteIp(),
      this.clientAgent,
    );
    this.connectionId = connection.id;
    await this.deps.prisma.worker.update({
      where: { id: authorized.worker.id },
      data: { lastSeenAt: new Date() },
    });
    await this.forward(
      { ...message, params: [this.binding.username, this.binding.password] },
      'mining.authorize',
    );
    this.deps.events.publish('worker.connected', {
      workerId: authorized.worker.id,
      asset: AssetCode.BTC,
      remoteIp: this.remoteIp(),
      upstream: this.binding.upstream.name,
    });
  }

  private async submit(message: JsonRpcMessage): Promise<void> {
    if (!this.authorized || !this.connectionId || !this.binding || !this.upstream) {
      this.downstream.send({
        id: message.id ?? null,
        result: false,
        error: [24, 'Authorize first', null],
      });
      return;
    }
    const params: unknown[] = Array.isArray(message.params)
      ? message.params.map((value: unknown) => value)
      : [];
    params[0] = this.binding.username;
    const jobId =
      typeof params[1] === 'string' || typeof params[1] === 'number' ? String(params[1]) : '';
    const nonce =
      typeof params[4] === 'string' || typeof params[4] === 'number' ? String(params[4]) : '';
    const requestKey = `${String(message.id ?? 'null')}:${jobId}:${nonce}:${Date.now()}`;
    const shareEvent = await this.deps.journal.pending({
      auth: this.authorized,
      upstreamId: this.binding.upstream.id,
      connectionId: this.connectionId,
      requestKey,
      difficulty: this.difficulty,
    });
    await this.forward({ ...message, params }, 'mining.submit', shareEvent);
  }

  private async forward(
    message: JsonRpcMessage,
    method: string,
    shareEvent?: PendingRpc['shareEvent'],
  ): Promise<void> {
    await this.ensureUpstream();
    if (!this.upstream) throw new Error('Bitcoin upstream is unavailable');
    const upstreamId = this.nextId++;
    this.pending.set(String(upstreamId), {
      downstreamId: message.id ?? null,
      method,
      shareEvent,
      startedAt: performance.now(),
    });
    this.upstream.send({ ...message, id: upstreamId });
  }

  private async onUpstream(message: JsonRpcMessage): Promise<void> {
    if (message.method) {
      if (message.method === 'client.reconnect') {
        void this.close('upstream-requested-reconnect', true);
        return;
      }
      if (message.method === 'mining.set_difficulty' && Array.isArray(message.params)) {
        const next: unknown = message.params[0];
        if (typeof next === 'number' || typeof next === 'string') this.difficulty = String(next);
      }
      this.downstream.send(message);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    if (pending.shareEvent) {
      const accepted =
        message.result === true && (message.error === null || message.error === undefined);
      const reason = accepted ? undefined : JSON.stringify(message.error ?? 'Share rejected');
      await this.deps.journal.resolve(
        pending.shareEvent,
        accepted,
        Math.round(performance.now() - pending.startedAt),
        reason,
      );
    }
    this.downstream.send({ ...message, id: pending.downstreamId });
    if (pending.method === 'mining.authorize' && message.result !== true) {
      void this.close('upstream-authorization-failed');
    }
  }

  private async upstreamFailed(error: Error): Promise<void> {
    await this.close(`upstream-failed:${error.message}`, true);
  }

  private startLeaseHeartbeat(): void {
    this.leaseTimer = setInterval(() => {
      if (!this.authorized) return;
      void this.deps.authService
        .renewConnection(this.authorized.worker.id, this.authorized.connectionLeaseId)
        .then((renewed) => {
          if (!renewed) void this.close('connection-lease-lost', true);
        })
        .catch(() => void this.close('connection-lease-error', true));
    }, 60_000);
    this.leaseTimer.unref();
  }

  async close(code: string, destroyDownstream = false): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.authTimer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    const pendingShares = [...this.pending.values()].flatMap((item) =>
      item.shareEvent ? [item.shareEvent] : [],
    );
    await this.deps.journal.unknown(pendingShares, code).catch(() => undefined);
    this.pending.clear();
    if (this.binding && code.startsWith('upstream-')) {
      await this.deps.runtime
        .failure(this.binding.upstream, new Error(code))
        .catch(() => undefined);
    }
    this.upstream?.destroy();
    if (destroyDownstream || !this.socket.destroyed) this.downstream.destroy();
    if (this.connectionId)
      await this.deps.journal.closeConnection(this.connectionId, code).catch(() => undefined);
    if (this.authorized && this.countedConnection) {
      await this.deps.authService
        .connectionClosed(this.authorized.worker.id, this.authorized.connectionLeaseId)
        .catch(() => undefined);
      this.countedConnection = false;
      if (this.connectionId)
        this.deps.events.publish('worker.disconnected', {
          workerId: this.authorized.worker.id,
          asset: AssetCode.BTC,
          code,
        });
    }
  }
}
