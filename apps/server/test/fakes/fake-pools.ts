import { createServer, type Server, type Socket } from 'node:net';

type JsonObject = Record<string, unknown>;

export interface FakePoolOptions {
  rejectSubmit?: boolean;
  rejectAuthentication?: boolean;
  responseDelayMs?: number;
  malformedAfterMessages?: number;
  disconnectAfterMessages?: number;
}

abstract class FakeLinePool {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private portValue = 0;
  readonly messages: JsonObject[] = [];

  protected constructor(private readonly options: FakePoolOptions = {}) {
    this.server = createServer((socket) => this.accept(socket));
  }

  get port(): number {
    return this.portValue;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fake pool did not bind to TCP');
    this.portValue = address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  protected abstract response(message: JsonObject): JsonObject | null;

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    let buffer = '';
    let count = 0;
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (!line) continue;
        this.messages.push(JSON.parse(line) as JsonObject);
        count += 1;
        if (this.options.disconnectAfterMessages === count) {
          socket.destroy();
          return;
        }
        if (this.options.malformedAfterMessages === count) {
          socket.write('{malformed\n');
          continue;
        }
        const response = this.response(this.messages.at(-1)!);
        if (!response) continue;
        setTimeout(
          () => socket.write(`${JSON.stringify(response)}\n`),
          this.options.responseDelayMs ?? 0,
        );
      }
    });
  }
}

export class FakeBitcoinPool extends FakeLinePool {
  constructor(private readonly behavior: FakePoolOptions = {}) {
    super(behavior);
  }

  protected response(message: JsonObject): JsonObject {
    const id = message.id ?? null;
    switch (message.method) {
      case 'mining.subscribe':
        return {
          id,
          result: [[['mining.notify', 'fake-subscription']], '01020304', 4],
          error: null,
        };
      case 'mining.authorize':
        return this.behavior.rejectAuthentication
          ? { id, result: false, error: [24, 'unauthorized worker', null] }
          : { id, result: true, error: null };
      case 'mining.configure':
        return { id, result: { 'version-rolling': true }, error: null };
      case 'mining.submit':
        return this.behavior.rejectSubmit
          ? { id, result: false, error: [23, 'low difficulty share', null] }
          : { id, result: true, error: null };
      default:
        return { id, result: null, error: null };
    }
  }
}

export class FakeMoneroPool extends FakeLinePool {
  constructor(private readonly behavior: FakePoolOptions = {}) {
    super(behavior);
  }

  protected response(message: JsonObject): JsonObject {
    const id = message.id ?? null;
    switch (message.method) {
      case 'login':
        if (this.behavior.rejectAuthentication) {
          return {
            id,
            jsonrpc: '2.0',
            error: { code: -1, message: 'Invalid login' },
          };
        }
        return {
          id,
          jsonrpc: '2.0',
          result: {
            id: 'fake-session',
            status: 'OK',
            job: {
              blob: '00'.repeat(76),
              job_id: 'fake-job',
              target: 'ffffff7f',
              height: 1,
              seed_hash: '00'.repeat(32),
            },
          },
        };
      case 'submit':
        return this.behavior.rejectSubmit
          ? { id, jsonrpc: '2.0', error: { code: -1, message: 'Low difficulty share' } }
          : { id, jsonrpc: '2.0', result: { status: 'OK' } };
      default:
        return { id, jsonrpc: '2.0', result: { status: 'KEEPALIVED' } };
    }
  }
}
