import type { Socket } from 'node:net';
import { connect as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import type { Upstream } from '@prisma/client';

export async function connectUpstream(upstream: Upstream): Promise<Socket> {
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
