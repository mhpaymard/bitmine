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
});
