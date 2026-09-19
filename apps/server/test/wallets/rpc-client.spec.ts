import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcClient, RpcError } from '../../src/wallets/rpc-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('JsonRpcClient', () => {
  it('uses JSON-RPC IDs, basic authentication, and does not expose the password in the body', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'first' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: 'second' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new JsonRpcClient('http://wallet.test/json_rpc', 'rpc-user', () => 'rpc-pass');

    await expect(client.call('one', { value: 1 })).resolves.toBe('first');
    await expect(client.call('two')).resolves.toBe('second');

    const first = fetchMock.mock.calls[0];
    expect(first?.[0]).toBe('http://wallet.test/json_rpc');
    expect(first?.[1]?.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('rpc-user:rpc-pass').toString('base64')}`,
      'content-type': 'application/json',
    });
    const firstBody = first?.[1]?.body;
    const secondBody = fetchMock.mock.calls[1]?.[1]?.body;
    if (typeof firstBody !== 'string' || typeof secondBody !== 'string')
      throw new Error('Expected JSON string request bodies');
    expect(JSON.parse(firstBody) as unknown).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'one',
      params: { value: 1 },
    });
    expect((JSON.parse(secondBody) as { id?: unknown }).id).toBe(2);
    expect(firstBody).not.toContain('rpc-pass');
  });

  it('turns HTTP and JSON-RPC failures into typed RpcError values', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Unavailable' }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: -5, message: 'missing transaction', data: 'txid' } }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const client = new JsonRpcClient('http://wallet.test');

    await expect(client.call('status')).rejects.toThrow('RPC HTTP 503 Unavailable');
    const error = await client.call('gettransaction').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -5, message: 'missing transaction', data: 'txid' });
  });

  it('answers a digest authentication challenge without putting the password in the body', async () => {
    const challenge =
      'Digest realm="monero-rpc", nonce="abc123", qop="auth", opaque="opaque-token", algorithm=MD5, Digest realm="monero-rpc", nonce="abc123", qop="auth", algorithm=MD5-sess';
    const md5 = (value: string) => createHash('md5').update(value).digest('hex');
    const observed: Array<{ authorization?: string; body: string; remotePort?: number }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const authorization = request.headers.authorization;
        observed.push({
          authorization,
          body: Buffer.concat(chunks).toString('utf8'),
          remotePort: request.socket.remotePort,
        });
        if (!authorization) {
          response.writeHead(401, { 'www-authenticate': challenge });
          response.end('Authentication required');
          return;
        }
        const cnonce = authorization.match(/cnonce="([a-f0-9]+)"/u)?.[1];
        const actualResponse = authorization.match(/response="([a-f0-9]+)"/u)?.[1];
        const expectedResponse = md5(
          `${md5('rpc-user:monero-rpc:rpc-pass')}:abc123:00000001:${cnonce}:auth:${md5(
            'POST:/json_rpc?network=stage',
          )}`,
        );
        if (actualResponse !== expectedResponse) {
          response.writeHead(401);
          response.end('Invalid digest');
          return;
        }
        response.setHeader('connection', 'close');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ result: { height: 42 } }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Digest test server did not bind');
      const client = new JsonRpcClient(
        `http://127.0.0.1:${address.port}/json_rpc?network=stage`,
        'rpc-user',
        () => 'rpc-pass',
        'digest',
      );

      await expect(client.call('get_height')).resolves.toEqual({ height: 42 });
      expect(observed).toHaveLength(2);
      expect(observed[0]?.authorization).toBeUndefined();
      const authorization = observed[1]?.authorization;
      if (!authorization) throw new Error('Expected digest authorization header');
      expect(authorization).toContain('Digest username="rpc-user"');
      expect(authorization).toContain('realm="monero-rpc"');
      expect(authorization).toContain('nonce="abc123"');
      expect(authorization).toContain('uri="/json_rpc?network=stage"');
      expect(authorization).toContain('qop="auth"');
      expect(authorization).toContain('nc=00000001');
      expect(authorization).toContain('opaque="opaque-token"');
      expect(observed[0]?.remotePort).toBe(observed[1]?.remotePort);
      expect(observed.every((request) => !request.body.includes('rpc-pass'))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
