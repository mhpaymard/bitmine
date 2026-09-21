import type { Socket } from 'node:net';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { Upstream } from '@prisma/client';
import { SocksClient } from 'socks';
import { ProxyProtocol } from '../network/proxy-settings.dto';
import type { ResolvedGatewayProxy } from '../network/proxy-settings.service';

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function dialSocks5Tunnel(
  destinationHost: string,
  destinationPort: number,
  proxy: ResolvedGatewayProxy,
  timeoutMs: number,
): Promise<Socket> {
  const { socket } = await SocksClient.createConnection({
    proxy: {
      host: proxy.host,
      port: proxy.port,
      type: 5,
      userId: proxy.username,
      password: proxy.password,
    },
    command: 'connect',
    destination: { host: destinationHost, port: destinationPort },
    timeout: timeoutMs,
  });
  return socket;
}

function dialHttpConnectTunnel(
  destinationHost: string,
  destinationPort: number,
  proxy: ResolvedGatewayProxy,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connectTcp({ host: proxy.host, port: proxy.port });
    const timer = setTimeout(() => {
      socket.destroy(new Error('Proxy CONNECT tunnel timed out'));
    }, timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once('connect', () => {
      const authHeader = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT ${destinationHost}:${destinationPort} HTTP/1.1\r\n` +
          `Host: ${destinationHost}:${destinationPort}\r\n${authHeader}` +
          'Connection: keep-alive\r\n\r\n',
      );
    });
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      clearTimeout(timer);
      socket.off('data', onData);
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'));
      const statusCode = Number(statusLine.split(' ')[1]);
      if (statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine || 'no response'}`));
        return;
      }
      const trailing = buffer.slice(headerEnd + 4);
      if (trailing) socket.unshift(Buffer.from(trailing, 'latin1'));
      resolve(socket);
    };
    socket.on('data', onData);
    socket.once('error', fail);
  });
}

function finalizeSocket(rawSocket: Socket, upstream: Upstream, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    if (!upstream.tls) {
      rawSocket.setKeepAlive(true, 30_000);
      rawSocket.setNoDelay(true);
      resolve(rawSocket);
      return;
    }
    const timer = setTimeout(() => {
      rawSocket.destroy(new Error(`TLS handshake to ${upstream.name} timed out`));
    }, timeoutMs);
    // A tunneled socket (SOCKS5/CONNECT) must be explicitly paused before tls.connect() takes
    // it over; without this the flowing/paused transition is unreliable and the handshake hangs.
    rawSocket.pause();
    const tlsSocket = connectTls({
      socket: rawSocket,
      servername: upstream.host,
      rejectUnauthorized: true,
    });
    tlsSocket.once('secureConnect', () => {
      clearTimeout(timer);
      tlsSocket.setKeepAlive(true, 30_000);
      tlsSocket.setNoDelay(true);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function connectDirect(upstream: Upstream): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const options = { host: upstream.host, port: upstream.port };
    const socket = upstream.tls
      ? connectTls({ ...options, servername: upstream.host, rejectUnauthorized: true })
      : connectTcp(options);
    const timeout = setTimeout(
      () => socket.destroy(new Error(`Connection to ${upstream.name} timed out`)),
      upstream.connectionTimeoutMs,
    );
    const connectedEvent = upstream.tls ? 'secureConnect' : 'connect';
    socket.once(connectedEvent, () => {
      clearTimeout(timeout);
      socket.setKeepAlive(true, 30_000);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function connectViaProxy(upstream: Upstream, proxy: ResolvedGatewayProxy): Promise<Socket> {
  const timeoutMs = upstream.connectionTimeoutMs;
  const tunnel = await withTimeout(
    proxy.protocol === ProxyProtocol.SOCKS5
      ? dialSocks5Tunnel(upstream.host, upstream.port, proxy, timeoutMs)
      : dialHttpConnectTunnel(upstream.host, upstream.port, proxy, timeoutMs),
    timeoutMs,
    `Proxy tunnel to ${upstream.name} via ${proxy.host}:${proxy.port} timed out`,
  );
  return finalizeSocket(tunnel, upstream, timeoutMs);
}

export async function connectUpstream(
  upstream: Upstream,
  proxy?: ResolvedGatewayProxy | null,
): Promise<Socket> {
  return proxy ? connectViaProxy(upstream, proxy) : connectDirect(upstream);
}
