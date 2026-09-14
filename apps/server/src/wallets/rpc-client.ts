export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export class JsonRpcClient {
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly username?: string,
    private readonly password?: () => string,
  ) {}

  async call<T>(method: string, params: unknown = []): Promise<T> {
    const authorization =
      this.username && this.password
        ? `Basic ${Buffer.from(`${this.username}:${this.password()}`).toString('base64')}`
        : undefined;
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new RpcError(`RPC HTTP ${response.status} ${response.statusText}`);
    const payload = (await response.json()) as {
      result?: T;
      error?: { code?: number; message?: string; data?: unknown } | null;
    };
    if (payload.error)
      throw new RpcError(
        payload.error.message ?? `RPC ${method} failed`,
        payload.error.code,
        payload.error.data,
      );
    return payload.result as T;
  }
}
