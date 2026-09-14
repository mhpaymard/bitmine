import { connect, createServer, type Socket } from 'node:net';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../src/config/environment';
import { GatewayService } from '../../src/gateway/gateway.service';

const sockets: Socket[] = [];
const shutdowns: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const shutdown of shutdowns.splice(0).reverse()) await shutdown();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function open(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return socket;
}

describe('gateway admission limits', () => {
  it('rejects excess unauthenticated sockets from one IP before allocating more upstream work', async () => {
    const port = await freePort();
    const values: Record<string, unknown> = {
      GATEWAY_ENABLED: true,
      BITCOIN_GATEWAY_TCP_ENABLED: true,
      BITCOIN_GATEWAY_HOST: '127.0.0.1',
      BITCOIN_GATEWAY_PORT: port,
      BITCOIN_GATEWAY_TLS_ENABLED: false,
      MONERO_GATEWAY_TCP_ENABLED: false,
      MONERO_GATEWAY_TLS_ENABLED: false,
      GATEWAY_MAX_CONNECTIONS: 10,
      GATEWAY_MAX_CONNECTIONS_PER_IP: 10,
      GATEWAY_MAX_UNAUTHENTICATED_PER_IP: 1,
      GATEWAY_MAX_LINE_BYTES: 65_536,
      GATEWAY_IDLE_TIMEOUT_MS: 30_000,
      GATEWAY_AUTH_TIMEOUT_MS: 30_000,
    };
    const service = new GatewayService(
      { get: (key: string) => values[key] } as ConfigService<Environment, true>,
      {} as never,
      { unknown: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.onApplicationBootstrap();
    shutdowns.push(() => service.onApplicationShutdown());
    await open(port);
    const rejected = await open(port);

    const response = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Admission response timed out')), 2_000);
      rejected.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk.toString('utf8'));
      });
    });

    expect(JSON.parse(response.trim())).toMatchObject({
      error: [24, 'Too many unauthenticated connections', null],
    });
    expect(service.status().activeSockets).toBe(1);
  });
});
