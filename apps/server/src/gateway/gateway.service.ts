import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';
import { ProxyHealthService } from '../network/proxy-health.service';
import { UpstreamsService } from '../upstreams/upstreams.service';
import { BitcoinGatewaySession } from './bitcoin-gateway.session';
import { GatewayAuthService } from './gateway-auth.service';
import { MoneroGatewaySession } from './monero-gateway.session';
import { ShareJournalService } from './share-journal.service';
import { UpstreamRuntimeService } from './upstream-runtime.service';

@Injectable()
export class GatewayService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(GatewayService.name);
  private readonly servers: Server[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly listeners: string[] = [];
  private activeSockets = 0;
  private readonly socketsByIp = new Map<string, number>();
  private readonly unauthenticatedByIp = new Map<string, number>();

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly authService: GatewayAuthService,
    private readonly journal: ShareJournalService,
    private readonly upstreams: UpstreamsService,
    private readonly runtime: UpstreamRuntimeService,
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
    private readonly proxyHealth: ProxyHealthService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('GATEWAY_ENABLED', { infer: true })) {
      this.logger.warn('Mining TCP gateways are disabled');
      return;
    }
    const listeners: Promise<void>[] = [];
    if (this.config.get('BITCOIN_GATEWAY_TCP_ENABLED', { infer: true })) {
      listeners.push(
        this.listenTcp(
          this.config.get('BITCOIN_GATEWAY_HOST', { infer: true }),
          this.config.get('BITCOIN_GATEWAY_PORT', { infer: true }),
          (socket) => new BitcoinGatewaySession(socket, this.dependencies()),
          'Bitcoin Stratum V1 TCP',
        ),
      );
    }
    if (this.config.get('BITCOIN_GATEWAY_TLS_ENABLED', { infer: true })) {
      listeners.push(
        this.listenTls(
          this.config.get('BITCOIN_GATEWAY_TLS_HOST', { infer: true }),
          this.config.get('BITCOIN_GATEWAY_TLS_PORT', { infer: true }),
          this.config.get('BITCOIN_GATEWAY_TLS_CERT_FILE', { infer: true }),
          this.config.get('BITCOIN_GATEWAY_TLS_KEY_FILE', { infer: true }),
          (socket) => new BitcoinGatewaySession(socket, this.dependencies()),
          'Bitcoin Stratum V1 TLS',
        ),
      );
    }
    if (this.config.get('MONERO_GATEWAY_TCP_ENABLED', { infer: true })) {
      listeners.push(
        this.listenTcp(
          this.config.get('MONERO_GATEWAY_HOST', { infer: true }),
          this.config.get('MONERO_GATEWAY_PORT', { infer: true }),
          (socket) => new MoneroGatewaySession(socket, this.dependencies()),
          'Monero JSON-RPC TCP',
        ),
      );
    }
    if (this.config.get('MONERO_GATEWAY_TLS_ENABLED', { infer: true })) {
      listeners.push(
        this.listenTls(
          this.config.get('MONERO_GATEWAY_TLS_HOST', { infer: true }),
          this.config.get('MONERO_GATEWAY_TLS_PORT', { infer: true }),
          this.config.get('MONERO_GATEWAY_TLS_CERT_FILE', { infer: true }),
          this.config.get('MONERO_GATEWAY_TLS_KEY_FILE', { infer: true }),
          (socket) => new MoneroGatewaySession(socket, this.dependencies()),
          'Monero JSON-RPC TLS',
        ),
      );
    }
    if (!listeners.length) this.logger.warn('No mining TCP/TLS listener is enabled');
    await Promise.all(listeners);
  }

  private dependencies() {
    return {
      config: this.config,
      authService: this.authService,
      journal: this.journal,
      upstreams: this.upstreams,
      runtime: this.runtime,
      prisma: this.prisma,
      events: this.events,
      proxyHealth: this.proxyHealth,
    };
  }

  private listenTcp(
    host: string,
    port: number,
    createSession: (socket: Socket) => unknown,
    label: string,
  ): Promise<void> {
    return this.bind(createServer(this.accept(createSession)), host, port, label);
  }

  private listenTls(
    host: string,
    port: number,
    certFile: string,
    keyFile: string,
    createSession: (socket: Socket) => unknown,
    label: string,
  ): Promise<void> {
    const cert = readFileSync(resolve(process.cwd(), certFile));
    const key = readFileSync(resolve(process.cwd(), keyFile));
    const server = createTlsServer(
      { cert, key, minVersion: 'TLSv1.2', requestCert: false },
      this.accept(createSession),
    );
    server.on('tlsClientError', (error) =>
      this.logger.warn(`TLS client rejected: ${error.message}`),
    );
    return this.bind(server, host, port, label);
  }

  private accept(createSession: (socket: Socket) => unknown): (socket: Socket) => void {
    return (socket) => {
      const remoteIp = socket.remoteAddress?.replace(/^::ffff:/u, '') ?? 'unknown';
      const activeForIp = this.socketsByIp.get(remoteIp) ?? 0;
      const unauthenticatedForIp = this.unauthenticatedByIp.get(remoteIp) ?? 0;
      if (this.activeSockets >= this.config.get('GATEWAY_MAX_CONNECTIONS', { infer: true })) {
        socket.end(
          JSON.stringify({ id: null, error: [20, 'Gateway connection limit reached', null] }) +
            '\n',
        );
        return;
      }
      if (activeForIp >= this.config.get('GATEWAY_MAX_CONNECTIONS_PER_IP', { infer: true })) {
        socket.end(
          JSON.stringify({ id: null, error: [20, 'Gateway per-IP limit reached', null] }) + '\n',
        );
        return;
      }
      if (
        unauthenticatedForIp >=
        this.config.get('GATEWAY_MAX_UNAUTHENTICATED_PER_IP', { infer: true })
      ) {
        socket.end(
          JSON.stringify({ id: null, error: [24, 'Too many unauthenticated connections', null] }) +
            '\n',
        );
        return;
      }
      this.activeSockets += 1;
      this.sockets.add(socket);
      this.socketsByIp.set(remoteIp, activeForIp + 1);
      this.unauthenticatedByIp.set(remoteIp, unauthenticatedForIp + 1);
      let authenticated = false;
      socket.once('gateway:authorized', () => {
        if (authenticated) return;
        authenticated = true;
        this.decrementIpCounter(this.unauthenticatedByIp, remoteIp);
      });
      socket.once('close', () => {
        this.sockets.delete(socket);
        this.activeSockets = Math.max(0, this.activeSockets - 1);
        this.decrementIpCounter(this.socketsByIp, remoteIp);
        if (!authenticated) this.decrementIpCounter(this.unauthenticatedByIp, remoteIp);
      });
      createSession(socket);
    };
  }

  private decrementIpCounter(counter: Map<string, number>, remoteIp: string): void {
    const remaining = (counter.get(remoteIp) ?? 1) - 1;
    if (remaining <= 0) counter.delete(remoteIp);
    else counter.set(remoteIp, remaining);
  }

  private async bind(server: Server, host: string, port: number, label: string): Promise<void> {
    server.maxConnections = this.config.get('GATEWAY_MAX_CONNECTIONS', { infer: true });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        this.logger.log(`${label} listening on ${host}:${port}`);
        resolve();
      });
    });
    this.servers.push(server);
    this.listeners.push(`${label} ${host}:${port}`);
  }

  async onApplicationShutdown(): Promise<void> {
    const closed = Promise.all(
      this.servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const forceClose = setTimeout(() => {
      for (const socket of this.sockets) socket.destroy();
    }, 10_000);
    forceClose.unref();
    await closed;
    clearTimeout(forceClose);
  }

  status() {
    return {
      enabled: this.config.get('GATEWAY_ENABLED', { infer: true }),
      activeSockets: this.activeSockets,
      listeners: this.listeners,
    };
  }
}
