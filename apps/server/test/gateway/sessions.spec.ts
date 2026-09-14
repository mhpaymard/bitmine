import { createServer, connect, type Server, type Socket } from 'node:net';
import { AssetCode, EntityStatus, PoolProtocol, type Upstream } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BitcoinSessionDependencies } from '../../src/gateway/bitcoin-gateway.session';
import { BitcoinGatewaySession } from '../../src/gateway/bitcoin-gateway.session';
import type { AuthorizedWorker, JsonRpcMessage } from '../../src/gateway/gateway.types';
import { MoneroGatewaySession } from '../../src/gateway/monero-gateway.session';
import { FakeBitcoinPool, FakeMoneroPool } from '../fakes/fake-pools';

const openServers: Server[] = [];
const openSockets: Socket[] = [];
const openPools: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(openPools.splice(0).map((pool) => pool.stop()));
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function upstream(port: number, name = 'fake'): Upstream {
  return {
    id: `${name}-id`,
    accountKey: 'test-account',
    asset: AssetCode.BTC,
    protocol: PoolProtocol.BITCOIN_STRATUM_V1,
    name,
    host: '127.0.0.1',
    port,
    tls: false,
    priority: 10,
    enabled: true,
    usernameTemplate: 'pool.{customer}{worker}',
    passwordCiphertext: null,
    receiveAddress: null,
    connectionTimeoutMs: 500,
    failbackCooldownSeconds: 60,
    lastHealthAt: null,
    lastHealthOk: null,
    lastHealthMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function auth(asset: AssetCode): AuthorizedWorker {
  const now = new Date();
  return {
    connectionLeaseId: 'lease-1',
    customer: {
      id: 'customer-id',
      slug: 'alice',
      displayName: 'Alice',
      status: EntityStatus.ACTIVE,
      timezone: 'UTC',
      notes: null,
      createdAt: now,
      updatedAt: now,
    },
    worker: {
      id: 'worker-id',
      customerId: 'customer-id',
      slug: 'rig01',
      asset,
      status: EntityStatus.ACTIVE,
      maxConnections: 1,
      allowedIps: [],
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    },
    policy: {
      id: 'policy-id',
      customerId: 'customer-id',
      asset,
      customerBps: 8000,
      operatorBps: 2000,
      effectiveAt: now,
      createdById: null,
      createdAt: now,
    },
  };
}

function dependencies(candidates: Upstream[], asset: AssetCode) {
  const shareReference = { id: 'share-id', submittedAt: new Date() };
  const journalResolve = vi.fn().mockResolvedValue(undefined);
  const runtimeSuccess = vi.fn().mockResolvedValue(undefined);
  const runtimeFailure = vi.fn().mockResolvedValue(undefined);
  const deps = {
    config: {
      get: vi.fn((key: string) =>
        key === 'GATEWAY_MAX_LINE_BYTES'
          ? 65_536
          : key === 'GATEWAY_IDLE_TIMEOUT_MS' || key === 'GATEWAY_AUTH_TIMEOUT_MS'
            ? 30_000
            : 0,
      ),
    },
    authService: {
      authenticate: vi.fn().mockResolvedValue(auth(asset)),
      renewConnection: vi.fn().mockResolvedValue(true),
      connectionClosed: vi.fn().mockResolvedValue(undefined),
    },
    journal: {
      createConnection: vi.fn().mockResolvedValue({ id: 'connection-id' }),
      pending: vi.fn().mockResolvedValue(shareReference),
      resolve: journalResolve,
      unknown: vi.fn().mockResolvedValue(undefined),
      closeConnection: vi.fn().mockResolvedValue(undefined),
    },
    upstreams: {
      password: vi.fn().mockReturnValue('upstream-secret'),
      renderUsername: vi.fn().mockReturnValue('pool.alicerig01'),
    },
    runtime: {
      candidates: vi.fn().mockResolvedValue(candidates),
      success: runtimeSuccess,
      failure: runtimeFailure,
    },
    prisma: { worker: { update: vi.fn().mockResolvedValue(undefined) } },
    events: { publish: vi.fn() },
  };
  return {
    deps: deps as unknown as BitcoinSessionDependencies,
    shareReference,
    journalResolve,
    runtimeSuccess,
    runtimeFailure,
  };
}

async function gateway(
  factory: (socket: Socket) => unknown,
): Promise<{ port: number; socket: Socket }> {
  const server = createServer(factory);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway did not bind');
  const socket = connect(address.port, '127.0.0.1');
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return { port: address.port, socket };
}

function messages(socket: Socket): {
  next: () => Promise<JsonRpcMessage>;
  send: (message: JsonRpcMessage) => void;
} {
  const queue: JsonRpcMessage[] = [];
  const waiters: Array<(value: JsonRpcMessage) => void> = [];
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as JsonRpcMessage;
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else queue.push(value);
    }
  });
  return {
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Timed out waiting for message')),
              2_000,
            );
            waiters.push((value) => {
              clearTimeout(timer);
              resolve(value);
            });
          }),
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
  };
}

describe('gateway protocol sessions', () => {
  it('proxies Bitcoin subscribe, rewrites credentials and journals an accepted share', async () => {
    const pool = new FakeBitcoinPool();
    await pool.start();
    openPools.push(pool);
    const primary = upstream(pool.port);
    const { deps, shareReference, journalResolve } = dependencies([primary], AssetCode.BTC);
    const { socket } = await gateway((client) => new BitcoinGatewaySession(client, deps));
    const peer = messages(socket);

    peer.send({ id: 1, method: 'mining.subscribe', params: ['integration-test'] });
    expect((await peer.next()).id).toBe(1);
    peer.send({ id: 2, method: 'mining.authorize', params: ['alice.rig01', 'local-token'] });
    expect(await peer.next()).toMatchObject({ id: 2, result: true, error: null });
    peer.send({ id: 3, method: 'mining.submit', params: ['alice.rig01', 'job', 'x', 'y', '01'] });
    expect(await peer.next()).toMatchObject({ id: 3, result: true, error: null });

    expect(pool.messages.find((message) => message.method === 'mining.authorize')?.params).toEqual([
      'pool.alicerig01',
      'upstream-secret',
    ]);
    expect(journalResolve).toHaveBeenCalledWith(
      shareReference,
      true,
      expect.any(Number),
      undefined,
    );
    socket.destroy();
  });

  it('fails over to the next Bitcoin endpoint after a connection failure', async () => {
    const pool = new FakeBitcoinPool();
    await pool.start();
    openPools.push(pool);
    const dead = upstream(1, 'dead');
    const live = upstream(pool.port, 'live');
    const { deps, runtimeFailure, runtimeSuccess } = dependencies([dead, live], AssetCode.BTC);
    const { socket } = await gateway((client) => new BitcoinGatewaySession(client, deps));
    const peer = messages(socket);

    peer.send({ id: 1, method: 'mining.subscribe', params: ['integration-test'] });
    expect((await peer.next()).id).toBe(1);
    expect(runtimeFailure).toHaveBeenCalledWith(dead, expect.any(Error));
    expect(runtimeSuccess).toHaveBeenCalledWith(live);
    socket.destroy();
  });

  it('proxies a Monero login and journals an accepted submit', async () => {
    const pool = new FakeMoneroPool();
    await pool.start();
    openPools.push(pool);
    const endpoint = {
      ...upstream(pool.port),
      asset: AssetCode.XMR,
      protocol: PoolProtocol.MONERO_JSON_RPC,
    };
    const { deps, shareReference, journalResolve } = dependencies([endpoint], AssetCode.XMR);
    const { socket } = await gateway((client) => new MoneroGatewaySession(client, deps));
    const peer = messages(socket);

    peer.send({
      id: 1,
      jsonrpc: '2.0',
      method: 'login',
      params: { login: 'alice.rig01', pass: 'local-token', agent: 'integration-test' },
    });
    expect((await peer.next()).result).toBeTruthy();
    peer.send({
      id: 2,
      jsonrpc: '2.0',
      method: 'submit',
      params: { id: 'fake-session', job_id: 'fake-job', nonce: '00000001', result: '00' },
    });
    expect((await peer.next()).result).toEqual({ status: 'OK' });
    expect(journalResolve).toHaveBeenCalledWith(
      shareReference,
      true,
      expect.any(Number),
      undefined,
    );
    socket.destroy();
  });
});
