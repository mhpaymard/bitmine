import {
  connect as connectTcp,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from 'node:net';
import type { Upstream } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectUpstream } from '../../src/gateway/socket-connect';
import { ProxyProtocol } from '../../src/network/proxy-settings.dto';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
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
});
