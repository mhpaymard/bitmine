import type { Socket } from 'node:net';
import { AssetCode } from '@prisma/client';
import type { BitcoinSessionDependencies } from './bitcoin-gateway.session';
import type {
  AuthorizedWorker,
  JsonRpcMessage,
  PendingRpc,
  UpstreamBinding,
} from './gateway.types';
import { LineJsonPeer } from './line-json-peer';
import { MoneroPoolAdapter } from './pool-adapters';
import { connectUpstream } from './socket-connect';

export class MoneroGatewaySession {
  private readonly downstream: LineJsonPeer;
  private upstream?: LineJsonPeer;
  private binding?: UpstreamBinding;
  private authorized?: AuthorizedWorker;
  private connectionId?: string;
  private difficulty = '1';
  private nextId = 1;
  private readonly pending = new Map<string, PendingRpc>();
  private readonly adapter = new MoneroPoolAdapter();
  private closing = false;
  private countedConnection = false;
  private leaseTimer?: NodeJS.Timeout;
  private readonly authTimer: NodeJS.Timeout;

  constructor(
    private readonly socket: Socket,
    private readonly deps: BitcoinSessionDependencies,
  ) {
    this.downstream = new LineJsonPeer(
      socket,
      deps.config.get('GATEWAY_MAX_LINE_BYTES', { infer: true }),
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

  private async connectPool(): Promise<void> {
    const candidates = await this.deps.runtime.candidates(AssetCode.XMR);
    let lastError: unknown = new Error('No Monero upstream is enabled');
    for (const upstream of candidates) {
      try {
        const socket = await connectUpstream(upstream);
        this.binding = { upstream, username: '', password: this.deps.upstreams.password(upstream) };
        this.upstream = new LineJsonPeer(
          socket,
          this.deps.config.get('GATEWAY_MAX_LINE_BYTES', { infer: true }),
          (message) => this.onUpstream(message),
          (error) => {
            void this.close(`upstream-protocol:${error.message}`, true);
          },
        );
        socket.once('close', () => {
          if (!this.closing) void this.close('upstream-disconnected', true);
        });
        socket.once('error', (error) => {
          if (!this.closing) void this.close(`upstream-failed:${error.message}`, true);
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
    if (message.method === 'login') {
      await this.login(message);
      return;
    }
    if (message.method === 'submit') {
      await this.submit(message);
      return;
    }
    if (message.method === 'keepalived' && this.upstream) {
      this.forward(message, 'keepalived');
      return;
    }
    this.downstream.send({
      id: message.id ?? null,
      jsonrpc: '2.0',
      error: { code: -32601, message: 'Unsupported method' },
    });
  }

  private async login(message: JsonRpcMessage): Promise<void> {
    const params =
      message.params && typeof message.params === 'object' && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};
    const username = typeof params.login === 'string' ? params.login : '';
    const password = typeof params.pass === 'string' ? params.pass : '';
    const auth = await this.deps.authService.authenticate(
      AssetCode.XMR,
      username,
      password,
      this.remoteIp(),
    );
    if (!auth) {
      this.downstream.send({
        id: message.id ?? null,
        jsonrpc: '2.0',
        error: { code: -1, message: 'Local authorization failed' },
      });
      await this.close('authorization-failed');
      return;
    }
    this.authorized = auth;
    this.socket.emit('gateway:authorized');
    clearTimeout(this.authTimer);
    this.countedConnection = true;
    this.startLeaseHeartbeat();
    await this.connectPool();
    if (!this.binding) throw new Error('Monero upstream unavailable');
    this.binding.username = this.deps.upstreams.renderUsername(
      this.binding.upstream,
      auth.customer.slug,
      auth.worker.slug,
    );
    const connection = await this.deps.journal.createConnection(
      auth,
      this.binding.upstream.id,
      this.remoteIp(),
      typeof params.agent === 'string' ? params.agent : undefined,
    );
    this.connectionId = connection.id;
    await this.deps.prisma.worker.update({
      where: { id: auth.worker.id },
      data: { lastSeenAt: new Date() },
    });
    this.forward(
      {
        ...message,
        params: { ...params, login: this.binding.username, pass: this.binding.password },
      },
      'login',
    );
    this.deps.events.publish('worker.connected', {
      workerId: auth.worker.id,
      asset: AssetCode.XMR,
      remoteIp: this.remoteIp(),
      upstream: this.binding.upstream.name,
    });
  }

  private async submit(message: JsonRpcMessage): Promise<void> {
    if (!this.authorized || !this.connectionId || !this.binding || !this.upstream) {
      this.downstream.send({
        id: message.id ?? null,
        jsonrpc: '2.0',
        error: { code: -1, message: 'Login first' },
      });
      return;
    }
    const params =
      message.params && typeof message.params === 'object' && !Array.isArray(message.params)
        ? (message.params as Record<string, unknown>)
        : {};
    const jobId =
      typeof params.job_id === 'string' || typeof params.job_id === 'number'
        ? String(params.job_id)
        : '';
    const nonce =
      typeof params.nonce === 'string' || typeof params.nonce === 'number'
        ? String(params.nonce)
        : '';
    const requestKey = `${String(message.id ?? 'null')}:${jobId}:${nonce}:${Date.now()}`;
    const shareEvent = await this.deps.journal.pending({
      auth: this.authorized,
      upstreamId: this.binding.upstream.id,
      connectionId: this.connectionId,
      requestKey,
      difficulty: this.difficulty,
    });
    this.forward(message, 'submit', shareEvent);
  }

  private forward(
    message: JsonRpcMessage,
    method: string,
    shareEvent?: PendingRpc['shareEvent'],
  ): void {
    if (!this.upstream) throw new Error('Monero upstream unavailable');
    const upstreamId = this.nextId++;
    this.pending.set(String(upstreamId), {
      downstreamId: message.id ?? null,
      method,
      shareEvent,
      startedAt: performance.now(),
    });
    this.upstream.send({ ...message, id: upstreamId, jsonrpc: message.jsonrpc ?? '2.0' });
  }

  private updateDifficulty(message: JsonRpcMessage): void {
    const inspectJob = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const job = value as Record<string, unknown>;
      if (typeof job.target === 'string')
        this.difficulty = this.adapter.difficultyFromTarget(job.target);
      if (job.job) inspectJob(job.job);
    };
    inspectJob(message.params);
    inspectJob(message.result);
  }

  private async onUpstream(message: JsonRpcMessage): Promise<void> {
    this.updateDifficulty(message);
    if (message.method) {
      this.downstream.send(message);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    if (pending.shareEvent) {
      const accepted = !message.error && message.result !== null && message.result !== false;
      await this.deps.journal.resolve(
        pending.shareEvent,
        accepted,
        Math.round(performance.now() - pending.startedAt),
        accepted ? undefined : JSON.stringify(message.error ?? 'Share rejected'),
      );
    }
    this.downstream.send({ ...message, id: pending.downstreamId });
    if (pending.method === 'login' && message.error)
      await this.close('upstream-authorization-failed');
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
          asset: AssetCode.XMR,
          code,
        });
    }
  }
}
