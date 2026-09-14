import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';

interface Credential {
  username: string;
  password: string;
}

const asset = (process.env.LOAD_ASSET ?? 'BTC').toUpperCase();
const host = process.env.LOAD_HOST ?? '127.0.0.1';
const port = Number(process.env.LOAD_PORT ?? (asset === 'BTC' ? 3333 : 4444));
const connectionCount = Number(process.env.LOAD_CONNECTIONS ?? 100);
const holdMs = Number(process.env.LOAD_HOLD_MS ?? 30_000);
const credentialFile = process.env.LOAD_CREDENTIALS_FILE;

if (!credentialFile)
  throw new Error('LOAD_CREDENTIALS_FILE must point to a JSON array of worker credentials');
const credentials = JSON.parse(readFileSync(credentialFile, 'utf8')) as Credential[];
if (!credentials.length) throw new Error('The credentials file is empty');

const sockets: Socket[] = [];
const latencies: number[] = [];
let failures = 0;

function open(index: number): Promise<void> {
  const credential = credentials[index % credentials.length]!;
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = connect({ host, port });
    sockets.push(socket);
    let settled = false;
    let buffer = '';
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (ok) latencies.push(performance.now() - startedAt);
      else failures += 1;
      resolve();
    };
    socket.setTimeout(15_000, () => finish(false));
    socket.once('error', () => finish(false));
    socket.once('connect', () => {
      if (asset === 'BTC') {
        socket.write(
          `${JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['gateway-load/1.0'] })}\n`,
        );
        socket.write(
          `${JSON.stringify({ id: 2, method: 'mining.authorize', params: [credential.username, credential.password] })}\n`,
        );
      } else {
        socket.write(
          `${JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'login', params: { login: credential.username, pass: credential.password, agent: 'gateway-load/1.0' } })}\n`,
        );
      }
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (asset === 'BTC' && response.id === 2)
          finish(response.result === true && !response.error);
        if (asset === 'XMR' && response.id === 1)
          finish(Boolean(response.result) && !response.error);
      }
    });
  });
}

async function main(): Promise<void> {
  await Promise.all(Array.from({ length: connectionCount }, (_, index) => open(index)));
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  for (const socket of sockets) socket.destroy();

  latencies.sort((a, b) => a - b);
  const percentile = (value: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))] ?? 0;
  const report = {
    asset,
    requestedConnections: connectionCount,
    authenticatedConnections: latencies.length,
    failures,
    authenticationLatencyMs: {
      p50: Number(percentile(0.5).toFixed(2)),
      p95: Number(percentile(0.95).toFixed(2)),
      max: Number((latencies.at(-1) ?? 0).toFixed(2)),
    },
    holdMs,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
