import { createHash, randomBytes } from 'node:crypto';
import {
  Agent as HttpAgent,
  type IncomingMessage,
  type RequestOptions,
  request as httpRequest,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type AuthenticationMode = 'basic' | 'digest';

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

function parseDigestChallenge(header: string): Record<string, string> | null {
  if (!/^Digest\s+/iu.test(header)) return null;
  const result: Record<string, string> = {};
  const attributes = header.split(/,\s*Digest\s+/iu, 1)[0]!.replace(/^Digest\s+/iu, '');
  const matcher = /([a-z][a-z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/giu;
  for (const match of attributes.matchAll(matcher)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? match[3];
    if (key && value !== undefined) result[key] = value;
  }
  return result.realm && result.nonce ? result : null;
}

function quoteDigest(value: string): string {
  return `"${value.replace(/["\\]/gu, '\\$&')}"`;
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly digestAgent?: HttpAgent;
  private digestTail = Promise.resolve();

  constructor(
    private readonly url: string,
    private readonly username?: string,
    private readonly password?: () => string,
    private readonly authenticationMode: AuthenticationMode = 'basic',
  ) {
    if (authenticationMode === 'digest') {
      this.digestAgent = this.url.startsWith('https:')
        ? new HttpsAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 })
        : new HttpAgent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    }
  }

  async call<T>(method: string, params: unknown = []): Promise<T> {
    if (this.authenticationMode !== 'digest') return this.callOnce<T>(method, params);
    const previous = this.digestTail;
    let release!: () => void;
    this.digestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.callOnce<T>(method, params);
    } finally {
      release();
    }
  }

  private async callOnce<T>(method: string, params: unknown): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params });
    const basicAuthorization =
      this.authenticationMode === 'basic' && this.username && this.password
        ? `Basic ${Buffer.from(`${this.username}:${this.password()}`).toString('base64')}`
        : undefined;
    let response = await this.request(body, basicAuthorization);
    if (
      response.status === 401 &&
      this.authenticationMode === 'digest' &&
      this.username &&
      this.password
    ) {
      const challenge = parseDigestChallenge(response.headers.get('www-authenticate') ?? '');
      if (challenge) {
        await response.arrayBuffer();
        response = await this.request(body, this.digestAuthorization(challenge));
      }
    }
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

  private request(body: string, authorization?: string): Promise<Response> {
    if (this.authenticationMode === 'digest') return this.nodeRequest(body, authorization);
    return fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization ? { authorization } : {}),
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
  }

  private nodeRequest(body: string, authorization?: string): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const url = new URL(this.url);
      const options: RequestOptions = {
        method: 'POST',
        agent: this.digestAgent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...(authorization ? { authorization } : {}),
        },
      };
      const onResponse = (incoming: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.once('error', reject);
        incoming.once('end', () => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode ?? 500,
              statusText: incoming.statusMessage,
              headers,
            }),
          );
        });
      };
      const request =
        url.protocol === 'https:'
          ? httpsRequest(url, options, onResponse)
          : httpRequest(url, options, onResponse);
      request.setTimeout(30_000, () => request.destroy(new Error('RPC request timed out')));
      request.once('error', reject);
      request.end(body);
    });
  }

  private digestAuthorization(challenge: Record<string, string>): string {
    if (!this.username || !this.password) throw new Error('Digest credentials are unavailable');
    const url = new URL(this.url);
    const uri = `${url.pathname}${url.search}`;
    const realm = challenge.realm!;
    const nonce = challenge.nonce!;
    const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
    if (algorithm !== 'MD5' && algorithm !== 'MD5-SESS')
      throw new RpcError(`Unsupported RPC digest algorithm ${algorithm}`);
    const qop = challenge.qop
      ?.split(',')
      .map((value) => value.trim().toLowerCase())
      .find((value) => value === 'auth');
    if (challenge.qop && !qop) throw new RpcError('RPC digest challenge does not support auth qop');
    const cnonce = randomBytes(16).toString('hex');
    const nc = '00000001';
    const initialHa1 = md5(`${this.username}:${realm}:${this.password()}`);
    const ha1 = algorithm === 'MD5-SESS' ? md5(`${initialHa1}:${nonce}:${cnonce}`) : initialHa1;
    const ha2 = md5(`POST:${uri}`);
    const response = qop
      ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
      : md5(`${ha1}:${nonce}:${ha2}`);
    return [
      `Digest username=${quoteDigest(this.username)}`,
      `realm=${quoteDigest(realm)}`,
      `nonce=${quoteDigest(nonce)}`,
      `uri=${quoteDigest(uri)}`,
      ...(qop ? [`cnonce=${quoteDigest(cnonce)}`, `nc=${nc}`] : []),
      `algorithm=${algorithm}`,
      `response=${quoteDigest(response)}`,
      ...(challenge.opaque ? [`opaque=${quoteDigest(challenge.opaque)}`] : []),
      ...(qop ? [`qop=${quoteDigest(qop)}`] : []),
    ].join(',');
  }
}
