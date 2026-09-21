import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../../src/config/environment';
import { GatewayService } from '../../src/gateway/gateway.service';

const cleanup: Array<() => Promise<void> | void> = [];
const openssl = [
  'openssl',
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
].find(
  (candidate) =>
    (candidate === 'openssl' || existsSync(candidate)) &&
    spawnSync(candidate, ['version']).status === 0,
);
const opensslAvailable = Boolean(openssl);

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe('TLS mining listener', () => {
  it.runIf(opensslAvailable)('accepts Stratum JSON over TLS 1.2 or newer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mining-gateway-tls-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const cert = join(directory, 'cert.pem');
    const key = join(directory, 'key.pem');
    const generated = spawnSync(
      openssl!,
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { encoding: 'utf8' },
    );
    expect(generated.status, generated.stderr).toBe(0);
    const port = await freePort();
    const values: Record<string, unknown> = {
      GATEWAY_ENABLED: true,
      BITCOIN_GATEWAY_TCP_ENABLED: false,
      BITCOIN_GATEWAY_TLS_ENABLED: true,
      BITCOIN_GATEWAY_TLS_HOST: '127.0.0.1',
      BITCOIN_GATEWAY_TLS_PORT: port,
      BITCOIN_GATEWAY_TLS_CERT_FILE: cert,
      BITCOIN_GATEWAY_TLS_KEY_FILE: key,
      MONERO_GATEWAY_TCP_ENABLED: false,
      MONERO_GATEWAY_TLS_ENABLED: false,
      GATEWAY_MAX_CONNECTIONS: 10,
      GATEWAY_MAX_CONNECTIONS_PER_IP: 10,
      GATEWAY_MAX_UNAUTHENTICATED_PER_IP: 10,
      GATEWAY_MAX_LINE_BYTES: 65_536,
      GATEWAY_IDLE_TIMEOUT_MS: 30_000,
      GATEWAY_AUTH_TIMEOUT_MS: 30_000,
    };
    const config = { get: (keyName: string) => values[keyName] } as ConfigService<
      Environment,
      true
    >;
    const service = new GatewayService(
      config,
      {} as never,
      { unknown: vi.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await service.onApplicationBootstrap();
    cleanup.push(() => service.onApplicationShutdown());

    const socket = await new Promise<TLSSocket>((resolve, reject) => {
      const client = connectTls(
        { host: '127.0.0.1', port, rejectUnauthorized: false, minVersion: 'TLSv1.2' },
        () => resolve(client),
      );
      client.once('error', reject);
    });
    cleanup.push(() => {
      socket.destroy();
    });
    expect(socket.encrypted).toBe(true);
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TLS gateway response timed out')), 2_000);
      socket.once('data', (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(chunk.toString('utf8'));
      });
    });
    socket.write(`${JSON.stringify({ id: 7, method: 'unsupported', params: [] })}\n`);
    expect(JSON.parse((await response).trim())).toMatchObject({
      id: 7,
      error: [20, 'Unsupported method', 'unsupported'],
    });
    socket.destroy();
  });
});
