import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  connect as connectTcp,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer as createTlsServer, type TLSSocket } from 'node:tls';
import type { Upstream } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectUpstream } from '../../src/gateway/socket-connect';
import { ProxyProtocol } from '../../src/network/proxy-settings.dto';

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

const servers: Server[] = [];
const cleanup: Array<() => void> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
  for (const action of cleanup.splice(0).reverse()) action();
  vi.restoreAllMocks();
});

async function echoServer(): Promise<{ host: string; port: number }> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString('utf8')}`));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { host: address.address, port: address.port };
}

/** A minimal HTTP CONNECT proxy that really tunnels to the requested destination. */
async function httpConnectProxy(options: {
  requireAuth?: string;
  rejectWith?: string;
}): Promise<{ host: string; port: number; receivedAuth: string[] }> {
  const receivedAuth: string[] = [];
  const server = createServer((client: Socket) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      client.off('data', onData);
      const headerBlob = buffer.slice(0, headerEnd);
      const [requestLine, ...headerLines] = headerBlob.split('\r\n');
      const authHeader = headerLines.find((line) =>
        line.toLowerCase().startsWith('proxy-authorization'),
      );
      if (authHeader) receivedAuth.push(authHeader);
      const target = requestLine?.split(' ')[1] ?? '';
      if (options.requireAuth && !authHeader) {
        client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        return;
      }
      if (options.rejectWith) {
        client.end(options.rejectWith);
        return;
      }
      const [targetHost, targetPort] = target.split(':');
      const upstream = connectTcp({ host: targetHost, port: Number(targetPort) }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const trailing = buffer.slice(headerEnd + 4);
        if (trailing) upstream.write(Buffer.from(trailing, 'latin1'));
        client.pipe(upstream);
        upstream.pipe(client);
      });
    };
    client.on('data', onData);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { host: address.address, port: address.port, receivedAuth };
}

async function selfSignedTlsServer(): Promise<{ host: string; port: number }> {
  const directory = mkdtempSync(join(tmpdir(), 'mining-gateway-proxy-tls-'));
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
  if (generated.status !== 0) throw new Error(generated.stderr);
  const server = createTlsServer(
    { cert: readFileSync(cert), key: readFileSync(key) },
    (socket: TLSSocket) => {
      socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString('utf8')}`));
    },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { host: address.address, port: address.port };
}

function upstream(overrides: Partial<Upstream>): Upstream {
  return {
    id: 'u1',
    accountKey: 'a1',
    asset: 'BTC',
    protocol: 'BITCOIN_STRATUM_V1',
    name: 'test-pool',
    host: '127.0.0.1',
    port: 0,
    tls: false,
    priority: 0,
    enabled: true,
    usernameTemplate: '{username}',
    passwordCiphertext: null,
    receiveAddress: null,
    connectionTimeoutMs: 3_000,
    failbackCooldownSeconds: 60,
    lastHealthAt: null,
    lastHealthOk: null,
    lastHealthMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('connectUpstream via HTTP CONNECT proxy', () => {
  it('tunnels plaintext traffic end-to-end through the proxy', async () => {
    const destination = await echoServer();
    const proxy = await httpConnectProxy({});
    const socket = await connectUpstream(
      upstream({ host: destination.host, port: destination.port }),
      {
        protocol: ProxyProtocol.HTTP,
        host: proxy.host,
        port: proxy.port,
      },
    );
    const reply = await new Promise<string>((resolve) => {
      socket.once('data', (chunk) => resolve(chunk.toString('utf8')));
      socket.write('hello');
    });
    expect(reply).toBe('echo:hello');
    socket.destroy();
  });

  it('sends Proxy-Authorization when credentials are configured', async () => {
    const destination = await echoServer();
    const proxy = await httpConnectProxy({ requireAuth: 'yes' });
    const socket = await connectUpstream(
      upstream({ host: destination.host, port: destination.port }),
      {
        protocol: ProxyProtocol.HTTP,
        host: proxy.host,
        port: proxy.port,
        username: 'alice',
        password: 'secret',
      },
    );
    expect(proxy.receivedAuth[0]).toContain('Basic');
    socket.destroy();
  });

  it('rejects when the proxy refuses the CONNECT request', async () => {
    const destination = await echoServer();
    const proxy = await httpConnectProxy({ rejectWith: 'HTTP/1.1 502 Bad Gateway\r\n\r\n' });
    await expect(
      connectUpstream(upstream({ host: destination.host, port: destination.port }), {
        protocol: ProxyProtocol.HTTP,
        host: proxy.host,
        port: proxy.port,
      }),
    ).rejects.toThrow('Proxy CONNECT failed');
  });

  it.runIf(opensslAvailable)(
    'completes the TLS handshake over the tunnel quickly instead of hanging until the timeout',
    async () => {
      // Regression test: tls.connect() over a tunneled socket needs the socket explicitly
      // paused first, or the handshake silently hangs until the connection timeout. A
      // self-signed cert can't pass our hardcoded rejectUnauthorized:true, but a *fast*
      // certificate-validation failure proves the handshake bytes actually round-tripped
      // through the proxy -- a hung handshake would instead fail with our own timeout error
      // only after the full connectionTimeoutMs.
      const destination = await selfSignedTlsServer();
      const proxy = await httpConnectProxy({});
      const startedAt = Date.now();
      await expect(
        connectUpstream(
          upstream({
            host: destination.host,
            port: destination.port,
            tls: true,
            connectionTimeoutMs: 8_000,
          }),
          { protocol: ProxyProtocol.HTTP, host: proxy.host, port: proxy.port },
        ),
      ).rejects.toThrow(/certificate|self.signed/iu);
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    },
  );
});
