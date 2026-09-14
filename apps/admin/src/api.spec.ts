import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setCsrfToken } from './api';

afterEach(() => {
  setCsrfToken('');
  vi.unstubAllGlobals();
});

describe('admin API client', () => {
  it('sends cookies and the in-memory CSRF token', async () => {
    setCsrfToken('csrf-token');
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      api<{ ok: boolean }>('/api/test', { method: 'POST', body: '{}' }),
    ).resolves.toEqual({ ok: true });
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe('/api/test');
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('csrf-token');
  });

  it('normalizes structured API errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: ['invalid host', 'invalid port'] } }), {
          status: 400,
        }),
      ),
    );
    const error = await api('/api/test').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, message: 'invalid host, invalid port' });
  });
});
