import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { connect as connectTls } from 'node:tls';
import { Pool } from 'pg';
import { JsonRpcClient, RpcError } from '../../src/wallets/rpc-client';
import { FakeBitcoinPool, FakeMoneroPool } from '../fakes/fake-pools';
import { mineBitcoinCpu, ValidatingBitcoinPool } from './bitcoin-cpu-miner';

type JsonObject = Record<string, unknown>;

const serverRoot = resolve(process.cwd());
const projectRoot = resolve(serverRoot, '../..');
for (const environmentFile of [resolve(projectRoot, '.env'), resolve(serverRoot, '.env')]) {
  if (existsSync(environmentFile)) loadEnvFile(environmentFile);
}
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const exerciseRealXmrig = process.argv.includes('--xmrig');
const exercisePublicBitcoin = process.argv.includes('--bitcoin-public');
const exerciseRealBitcoinCpu = process.argv.includes('--bitcoin-cpu') || exercisePublicBitcoin;

const databaseUrl = process.env.DATABASE_URL ?? '';
if (!databaseUrl) throw new Error('DATABASE_URL is required for the local mining E2E test');

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to reserve a local port');
  const { port } = address;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return port;
}

async function uniquePorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) ports.add(await freePort());
  return [...ports];
}

async function runNode(
  args: string[],
  environment: NodeJS.ProcessEnv,
  label: string,
): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: serverRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${label} failed (${code ?? 'signal'}):\n${output.slice(-4000)}`));
    });
  });
}

async function waitForReady(
  baseUrl: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Gateway exited before readiness:\n${output().slice(-4000)}`);
    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      const body = (await response.json()) as { status?: string };
      if (response.ok && body.status === 'ok') return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`Gateway readiness timed out:\n${output().slice(-4000)}`);
}

async function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolveExit) => child.once('exit', () => resolveExit())),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 10_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function databaseWithName(source: string, name: string): string {
  const url = new URL(source);
  url.pathname = `/${name}`;
  url.searchParams.set('schema', 'public');
  return url.toString();
}

async function api<T>(input: {
  baseUrl: string;
  path: string;
  method?: string;
  body?: JsonObject;
  cookie?: string;
  csrf?: string;
}): Promise<{ body: T; cookie?: string }> {
  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method ?? 'GET',
    headers: {
      origin: input.baseUrl,
      ...(input.body ? { 'content-type': 'application/json' } : {}),
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.csrf ? { 'x-csrf-token': input.csrf } : {}),
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${input.method ?? 'GET'} ${input.path}: ${response.status} ${text}`);
  return {
    body: JSON.parse(text) as T,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
  };
}

function linePeer(socket: Socket): {
  send: (message: JsonObject) => void;
  next: () => Promise<JsonObject>;
} {
  const queue: JsonObject[] = [];
  const waiters: Array<(message: JsonObject) => void> = [];
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line) as JsonObject;
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else queue.push(message);
    }
  });
  return {
    send: (message) => socket.write(`${JSON.stringify(message)}\n`),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift()!)
        : new Promise<JsonObject>((resolveMessage, reject) => {
            const timer = setTimeout(
              () => reject(new Error('Timed out waiting for Stratum response')),
              5_000,
            );
            waiters.push((message) => {
              clearTimeout(timer);
              resolveMessage(message);
            });
          }),
  };
}

async function tlsSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolveSocket, reject) => {
    const certificatePath = resolve(
      serverRoot,
      process.env.BITCOIN_GATEWAY_TLS_CERT_FILE ?? '../../secrets/stratum-tls-cert.pem',
    );
    const socket = connectTls({
      host: '127.0.0.1',
      port,
      servername: 'gateway.local',
      ca: readFileSync(certificatePath),
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    socket.once('secureConnect', () => resolveSocket(socket));
    socket.once('error', reject);
  });
}

async function tcpSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolveSocket, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolveSocket(socket));
    socket.once('error', reject);
  });
}

async function exerciseBitcoin(
  port: number,
  username: string,
  password: string,
  useTls: boolean,
): Promise<void> {
  const socket = useTls ? await tlsSocket(port) : await tcpSocket(port);
  const peer = linePeer(socket);
  peer.send({ id: 1, method: 'mining.subscribe', params: ['local-e2e-miner/1.0'] });
  const subscribed = await peer.next();
  if (!subscribed.result)
    throw new Error(`Bitcoin subscribe failed: ${JSON.stringify(subscribed)}`);
  peer.send({ id: 2, method: 'mining.authorize', params: [username, password] });
  const authorized = await peer.next();
  if (authorized.result !== true)
    throw new Error(`Bitcoin authorize failed: ${JSON.stringify(authorized)}`);
  peer.send({
    id: 3,
    method: 'mining.submit',
    params: [username, 'fake-job', '00', '00000000', '00000001'],
  });
  const submitted = await peer.next();
  if (submitted.result !== true)
    throw new Error(`Bitcoin share failed: ${JSON.stringify(submitted)}`);
  socket.end();
}

async function exerciseMonero(
  port: number,
  username: string,
  password: string,
  useTls: boolean,
): Promise<void> {
  const socket = useTls ? await tlsSocket(port) : await tcpSocket(port);
  const peer = linePeer(socket);
  peer.send({
    id: 1,
    jsonrpc: '2.0',
    method: 'login',
    params: { login: username, pass: password, agent: 'local-e2e-miner/1.0' },
  });
  const loggedIn = await peer.next();
  if (!loggedIn.result) throw new Error(`Monero login failed: ${JSON.stringify(loggedIn)}`);
  peer.send({
    id: 2,
    jsonrpc: '2.0',
    method: 'submit',
    params: { id: 'fake-session', job_id: 'fake-job', nonce: '00000001', result: '00'.repeat(32) },
  });
  const submitted = await peer.next();
  if (!submitted.result) throw new Error(`Monero share failed: ${JSON.stringify(submitted)}`);
  socket.end();
}

async function runDocker(args: string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`docker ${args[0]} failed (${code ?? 'signal'}):\n${output}`));
    });
  });
}

async function exerciseMoneroWithXmrig(
  port: number,
  username: string,
  password: string,
  suffix: string,
): Promise<string> {
  const binaryPath = resolve(projectRoot, '.local/linux/xmrig-6.26.0/xmrig');
  if (!existsSync(binaryPath)) {
    throw new Error(
      `The optional real-miner test requires the verified Linux XMRig binary at ${binaryPath}`,
    );
  }
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'mining-gateway-xmrig-'));
  const configPath = resolve(temporaryDirectory, 'config.json');
  const containerName = `mining-gateway-xmrig-${suffix}`;
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        autosave: false,
        background: false,
        colors: false,
        randomx: { mode: 'light', '1gb-pages': false },
        cpu: { enabled: true, 'huge-pages': false, yield: true },
        pools: [
          {
            url: `host.docker.internal:${port}`,
            user: username,
            pass: password,
            coin: 'monero',
            keepalive: true,
          },
        ],
        'print-time': 1,
        'donate-level': 1,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  let child: ChildProcess | undefined;
  let output = '';
  try {
    child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--name',
        containerName,
        '--cpus',
        '1',
        '--memory',
        '3g',
        '--read-only',
        '--tmpfs',
        '/tmp',
        '-v',
        `${binaryPath}:/xmrig:ro`,
        '-v',
        `${configPath}:/xmrig-config.json:ro`,
        'debian:bookworm-slim',
        '/xmrig',
        '--config=/xmrig-config.json',
        '--threads=1',
        '--no-color',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    await new Promise<void>((resolveAccepted, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`XMRig did not submit a share within 90 seconds:\n${output}`)),
        90_000,
      );
      const inspect = (chunk: Buffer): void => {
        output += chunk.toString('utf8');
        if (/accepted \([1-9][0-9]*\/0\)/u.test(output)) {
          clearTimeout(timeout);
          resolveAccepted();
        }
      };
      child!.stdout?.on('data', inspect);
      child!.stderr?.on('data', inspect);
      child!.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child!.once('exit', (code) => {
        if (!/accepted \([1-9][0-9]*\/0\)/u.test(output)) {
          clearTimeout(timeout);
          reject(
            new Error(`XMRig exited before an accepted share (${code ?? 'signal'}):\n${output}`),
          );
        }
      });
    });
    await runDocker(['stop', '--time', '2', containerName]);
    await new Promise<void>((resolveExit) => {
      if (child?.exitCode !== null) resolveExit();
      else child?.once('exit', () => resolveExit());
    });
    return output;
  } finally {
    if (child?.exitCode === null)
      await runDocker(['stop', '--time', '2', containerName]).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const suffix = randomBytes(6).toString('hex');
  const databaseName = `mining_gateway_e2e_${suffix}`;
  const temporaryDatabaseUrl = databaseWithName(databaseUrl, databaseName);
  const ports = await uniquePorts(6);
  const httpPort = ports[0]!;
  const bitcoinPort = ports[1]!;
  const bitcoinTlsPort = ports[2]!;
  const moneroPort = ports[3]!;
  const moneroTlsPort = ports[4]!;
  const deadBitcoinPort = ports[5]!;
  const bitcoinPool = new FakeBitcoinPool();
  const validatingBitcoinPool = exerciseRealBitcoinCpu ? new ValidatingBitcoinPool() : undefined;
  const moneroPool = new FakeMoneroPool(exerciseRealXmrig ? { moneroTarget: 'ffffff03' } : {});
  const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
  let testPool: Pool | undefined;
  let gateway: ChildProcess | undefined;
  let gatewayOutput = '';
  let createdDatabase = false;
  try {
    await adminPool.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    createdDatabase = true;
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
      DATABASE_URL: temporaryDatabaseUrl,
      NODE_ENV: 'development',
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(httpPort),
      ADMIN_ORIGIN: `http://127.0.0.1:${httpPort}`,
      SERVE_ADMIN_STATIC: 'false',
      GATEWAY_ENABLED: 'true',
      BITCOIN_GATEWAY_HOST: '127.0.0.1',
      BITCOIN_GATEWAY_PORT: String(bitcoinPort),
      BITCOIN_GATEWAY_TCP_ENABLED: 'true',
      BITCOIN_GATEWAY_TLS_ENABLED: 'true',
      BITCOIN_GATEWAY_TLS_HOST: '127.0.0.1',
      BITCOIN_GATEWAY_TLS_PORT: String(bitcoinTlsPort),
      MONERO_GATEWAY_HOST: exerciseRealXmrig ? '0.0.0.0' : '127.0.0.1',
      MONERO_GATEWAY_PORT: String(moneroPort),
      MONERO_GATEWAY_TCP_ENABLED: 'true',
      MONERO_GATEWAY_TLS_ENABLED: 'true',
      MONERO_GATEWAY_TLS_HOST: '127.0.0.1',
      MONERO_GATEWAY_TLS_PORT: String(moneroTlsPort),
      ENABLE_MAINNET_PAYOUTS: 'false',
      BITCOIN_DAILY_AUTO_LIMIT_ATOMIC: '1000000',
    };
    const prismaCli = require.resolve('prisma/build/index.js');
    await runNode([prismaCli, 'migrate', 'deploy'], environment, 'Prisma migration');
    const adminPassword = randomSecret();
    await runNode(
      [resolve(serverRoot, 'dist/cli/bootstrap-admin.js')],
      {
        ...environment,
        BOOTSTRAP_ADMIN_EMAIL: 'e2e-owner@localhost.local',
        BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
      },
      'Admin bootstrap',
    );
    await Promise.all([
      bitcoinPool.start(),
      moneroPool.start(),
      validatingBitcoinPool?.start() ?? Promise.resolve(),
    ]);
    gateway = spawn(process.execPath, [resolve(serverRoot, 'dist/main.js')], {
      cwd: serverRoot,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    gateway.stdout?.on('data', (chunk: Buffer) => (gatewayOutput += chunk.toString('utf8')));
    gateway.stderr?.on('data', (chunk: Buffer) => (gatewayOutput += chunk.toString('utf8')));
    const baseUrl = `http://127.0.0.1:${httpPort}`;
    await waitForReady(baseUrl, gateway, () => gatewayOutput);
    const database = new Pool({ connectionString: temporaryDatabaseUrl, max: 1 });
    testPool = database;
    log('[PASS] Isolated database migrated and gateway became ready.');

    const login = await api<{ csrfToken: string }>({
      baseUrl,
      path: '/api/v1/auth/login',
      method: 'POST',
      body: { email: 'e2e-owner@localhost.local', password: adminPassword },
    });
    if (!login.cookie) throw new Error('Login did not set the session cookie');
    const session = { baseUrl, cookie: login.cookie, csrf: login.body.csrfToken };
    const mutate = <T>(path: string, body: JsonObject) =>
      api<T>({ ...session, path, method: 'POST', body });
    const patch = <T>(path: string, body: JsonObject) =>
      api<T>({ ...session, path, method: 'PATCH', body });
    const receiveAddress = await mutate<{ address: string }>('/api/v1/wallets/receive-address', {
      asset: 'BTC',
      label: `e2e-upstream-${suffix}`,
    });
    const payoutAddress = await mutate<{ address: string }>('/api/v1/wallets/receive-address', {
      asset: 'BTC',
      label: `e2e-payout-${suffix}`,
    });

    const accountKey = `e2e-btc-${suffix}`;
    const dead = await mutate<{ id: string }>('/api/v1/upstreams', {
      accountKey,
      asset: 'BTC',
      protocol: 'BITCOIN_STRATUM_V1',
      name: 'E2E BTC dead primary',
      host: '127.0.0.1',
      port: deadBitcoinPort,
      tls: false,
      priority: 1,
      usernameTemplate: 'pool.{customer}.{worker}',
      password: 'upstream-e2e-secret',
      receiveAddress: receiveAddress.body.address,
    });
    const liveBitcoin = await mutate<{ id: string }>('/api/v1/upstreams', {
      accountKey,
      asset: 'BTC',
      protocol: 'BITCOIN_STRATUM_V1',
      name: 'E2E BTC live failover',
      host: '127.0.0.1',
      port: bitcoinPool.port,
      tls: false,
      priority: 2,
      usernameTemplate: 'pool.{customer}.{worker}',
      password: 'upstream-e2e-secret',
      receiveAddress: receiveAddress.body.address,
    });
    const liveMonero = await mutate<{ id: string }>('/api/v1/upstreams', {
      asset: 'XMR',
      protocol: 'MONERO_JSON_RPC',
      name: 'E2E XMR live',
      host: '127.0.0.1',
      port: moneroPool.port,
      tls: false,
      priority: 1,
      usernameTemplate: 'pool.{customer}.{worker}',
      password: 'upstream-e2e-secret',
    });
    const deadProbe = await mutate<{ ok: boolean }>(`/api/v1/upstreams/${dead.body.id}/test`, {});
    const btcProbe = await mutate<{ ok: boolean }>(
      `/api/v1/upstreams/${liveBitcoin.body.id}/test`,
      {},
    );
    const xmrProbe = await mutate<{ ok: boolean }>(
      `/api/v1/upstreams/${liveMonero.body.id}/test`,
      {},
    );
    if (deadProbe.body.ok || !btcProbe.body.ok || !xmrProbe.body.ok)
      throw new Error('Upstream health probes did not distinguish dead and live endpoints');
    log('[PASS] Protocol-aware upstream checks and BTC failover endpoints validated.');

    const customer = await mutate<{ id: string }>('/api/v1/customers', {
      slug: `e2e-${suffix}`,
      displayName: 'Local mining E2E',
    });
    type WorkerResponse = { credentials: { username: string; password: string } };
    const btcWorker = await mutate<WorkerResponse>(
      `/api/v1/customers/${customer.body.id}/workers`,
      { slug: 'btc-rig', asset: 'BTC', maxConnections: 4, allowedIps: ['127.0.0.1/32'] },
    );
    const xmrWorker = await mutate<WorkerResponse>(
      `/api/v1/customers/${customer.body.id}/workers`,
      {
        slug: 'xmr-rig',
        asset: 'XMR',
        maxConnections: exerciseRealXmrig ? 3 : 2,
        allowedIps: exerciseRealXmrig ? ['0.0.0.0/0'] : ['127.0.0.1/32'],
      },
    );
    const portalAccess = await mutate<{
      customerSlug: string;
      accessCode: string;
      portalPath: string;
    }>(`/api/v1/customers/${customer.body.id}/portal-access/rotate`, {});
    const portalCredentials = {
      customerSlug: portalAccess.body.customerSlug,
      accessCode: portalAccess.body.accessCode,
    };
    const portalSummary = await api<{
      customer: { slug: string };
      workers: Array<{ id: string }>;
      balances: Array<{ asset: string }>;
      payoutSchedule: { nextAt: string };
    }>({
      baseUrl,
      path: '/api/v1/public/portal/summary',
      method: 'POST',
      body: portalCredentials,
    });
    if (
      portalSummary.body.customer.slug !== `e2e-${suffix}` ||
      portalSummary.body.workers.length !== 2 ||
      portalSummary.body.balances.length !== 2 ||
      !portalSummary.body.payoutSchedule.nextAt
    )
      throw new Error(`Unexpected customer portal summary: ${JSON.stringify(portalSummary.body)}`);
    const destination = await api<{ id: string; status: string; effectiveAt: string }>({
      baseUrl,
      path: '/api/v1/public/portal/payout-destinations',
      method: 'POST',
      body: {
        ...portalCredentials,
        asset: 'BTC',
        address: payoutAddress.body.address,
        minPayoutAtomic: '50000',
      },
    });
    if (destination.body.status !== 'PENDING')
      throw new Error(
        `Portal payout destination was not cooled: ${JSON.stringify(destination.body)}`,
      );
    log(
      '[PASS] Customer, workers, one-time portal access, public statistics and cooled wallet request validated through the API.',
    );

    await exerciseBitcoin(
      bitcoinPort,
      btcWorker.body.credentials.username,
      btcWorker.body.credentials.password,
      false,
    );
    await exerciseBitcoin(
      bitcoinTlsPort,
      btcWorker.body.credentials.username,
      btcWorker.body.credentials.password,
      true,
    );
    await exerciseMonero(
      moneroPort,
      xmrWorker.body.credentials.username,
      xmrWorker.body.credentials.password,
      false,
    );
    await exerciseMonero(
      moneroTlsPort,
      xmrWorker.body.credentials.username,
      xmrWorker.body.credentials.password,
      true,
    );
    log('[PASS] BTC and XMR miner flows accepted shares over both TCP and TLS.');

    const evidence = await database.query<{
      asset: string;
      accepted: string;
      rejected: string;
      sessions: string;
    }>(`
      SELECT
        s."asset"::text AS asset,
        COUNT(*) FILTER (WHERE s."status" = 'ACCEPTED')::text AS accepted,
        COUNT(*) FILTER (WHERE s."status" = 'REJECTED')::text AS rejected,
        COUNT(DISTINCT s."connectionId")::text AS sessions
      FROM "ShareEvent" s
      GROUP BY s."asset"
      ORDER BY s."asset"
    `);
    for (const asset of ['BTC', 'XMR']) {
      const row = evidence.rows.find((item) => item.asset === asset);
      if (
        !row ||
        Number(row.accepted) !== 2 ||
        Number(row.rejected) !== 0 ||
        Number(row.sessions) !== 2
      )
        throw new Error(`Unexpected ${asset} share evidence: ${JSON.stringify(row)}`);
    }
    if (
      !bitcoinPool.messages.some(
        (message) =>
          message.method === 'mining.authorize' &&
          Array.isArray(message.params) &&
          message.params[0] === `pool.e2e-${suffix}.btc-rig` &&
          message.params[1] === 'upstream-e2e-secret',
      )
    )
      throw new Error('Bitcoin upstream credential rewriting was not observed');
    if (
      !moneroPool.messages.some((message) => {
        if (message.method !== 'login' || !message.params || typeof message.params !== 'object')
          return false;
        const params = message.params as JsonObject;
        return (
          params.login === `pool.e2e-${suffix}.xmr-rig` && params.pass === 'upstream-e2e-secret'
        );
      })
    )
      throw new Error('Monero upstream credential rewriting was not observed');
    log('[PASS] PostgreSQL recorded 4/4 accepted shares and upstream credentials were rewritten.');

    if (exerciseRealBitcoinCpu) {
      if (!validatingBitcoinPool) throw new Error('Validating Bitcoin pool was not started');
      await patch(`/api/v1/upstreams/${liveBitcoin.body.id}`, { enabled: false });
      const validatingUpstream = await mutate<{ id: string }>('/api/v1/upstreams', {
        accountKey,
        asset: 'BTC',
        protocol: 'BITCOIN_STRATUM_V1',
        name: 'E2E BTC independent SHA256d validator',
        host: '127.0.0.1',
        port: validatingBitcoinPool.port,
        tls: false,
        priority: 2,
        usernameTemplate: 'pool.{customer}.{worker}',
        password: 'upstream-e2e-secret',
        receiveAddress: receiveAddress.body.address,
      });
      const validationProbe = await mutate<{ ok: boolean }>(
        `/api/v1/upstreams/${validatingUpstream.body.id}/test`,
        {},
      );
      if (!validationProbe.body.ok) throw new Error('SHA256d validation upstream probe failed');
      const mining = await mineBitcoinCpu({
        port: bitcoinPort,
        username: btcWorker.body.credentials.username,
        password: btcWorker.body.credentials.password,
        acceptedShares: 3,
        maxMiningMs: 60_000,
      });
      const persisted = await database.query<{ accepted: string; difficulty: string }>(
        `SELECT COUNT(*)::text AS accepted, MIN("difficulty")::text AS difficulty
         FROM "ShareEvent"
         WHERE "asset" = 'BTC' AND "upstreamId" = $1 AND "status" = 'ACCEPTED'`,
        [validatingUpstream.body.id],
      );
      if (
        validatingBitcoinPool.acceptedShares !== mining.accepted ||
        validatingBitcoinPool.rejectedShares !== 0 ||
        Number(persisted.rows[0]?.accepted ?? 0) !== mining.accepted ||
        Number(persisted.rows[0]?.difficulty ?? 0) !== validatingBitcoinPool.difficulty
      )
        throw new Error(
          `Real SHA256d evidence mismatch: ${JSON.stringify({ mining, pool: { accepted: validatingBitcoinPool.acceptedShares, rejected: validatingBitcoinPool.rejectedShares }, database: persisted.rows[0] })}`,
        );
      log(
        `[PASS] CPU SHA256d miner performed ${mining.hashes.toLocaleString('en-US')} real hashes at ${Math.round(mining.hashesPerSecond).toLocaleString('en-US')} H/s; ${mining.accepted}/${mining.accepted} shares were independently verified, forwarded and persisted.`,
      );

      if (exercisePublicBitcoin) {
        await Promise.all([
          patch(`/api/v1/upstreams/${dead.body.id}`, { enabled: false }),
          patch(`/api/v1/upstreams/${validatingUpstream.body.id}`, { enabled: false }),
        ]);
        const publicUpstream = await mutate<{ id: string }>('/api/v1/upstreams', {
          accountKey: `public-btc-${suffix}`,
          asset: 'BTC',
          protocol: 'BITCOIN_STRATUM_V1',
          name: 'Temporary public CKPool mainnet job test',
          host: 'stratum.ckpool.org',
          port: 3333,
          tls: false,
          priority: 1,
          usernameTemplate: '1BitcoinEaterAddressDontSendf59kuE.gateway-test',
          password: 'x',
        });
        const publicProbe = await mutate<{ ok: boolean; latencyMs: number; message: string }>(
          `/api/v1/upstreams/${publicUpstream.body.id}/test`,
          {},
        );
        if (!publicProbe.body.ok)
          throw new Error(`Public CKPool probe failed: ${JSON.stringify(publicProbe.body)}`);
        const publicMining = await mineBitcoinCpu({
          port: bitcoinPort,
          username: btcWorker.body.credentials.username,
          password: btcWorker.body.credentials.password,
          acceptedShares: 0,
          maxMiningMs: 10_000,
          submitShares: false,
        });
        if (publicMining.hashes <= 0 || publicMining.jobId.length === 0)
          throw new Error('Public Bitcoin job produced no CPU hashes');
        log(
          `[PASS] Public CKPool authenticated in ${publicProbe.body.latencyMs} ms, delivered a mainnet job at difficulty ${publicMining.difficulty.toLocaleString('en-US')}, and the CPU hashed it ${publicMining.hashes.toLocaleString('en-US')} times at ${Math.round(publicMining.hashesPerSecond).toLocaleString('en-US')} H/s without submitting work.`,
        );
        await patch(`/api/v1/upstreams/${liveBitcoin.body.id}`, { enabled: true });
      }
    }

    if (exerciseRealXmrig) {
      const submitsBefore = moneroPool.messages.filter(
        (message) => message.method === 'submit',
      ).length;
      const xmrigOutput = await exerciseMoneroWithXmrig(
        moneroPort,
        xmrWorker.body.credentials.username,
        xmrWorker.body.credentials.password,
        suffix,
      );
      const xmrigSubmits = moneroPool.messages.slice(submitsBefore).filter((message) => {
        if (message.method !== 'submit' || !message.params || typeof message.params !== 'object')
          return false;
        const result = (message.params as JsonObject).result;
        return typeof result === 'string' && result.length === 64 && result !== '00'.repeat(32);
      });
      const acceptedShares = await database.query<{ accepted: string }>(`
        SELECT COUNT(*)::text AS accepted
        FROM "ShareEvent"
        WHERE "asset" = 'XMR' AND "status" = 'ACCEPTED'
      `);
      if (!xmrigSubmits.length || Number(acceptedShares.rows[0]?.accepted ?? 0) <= 2)
        throw new Error('XMRig share was not forwarded and persisted as accepted');
      const speed = xmrigOutput.match(/speed 10s\/60s\/15m\s+([0-9.]+)/u)?.[1];
      log(
        `[PASS] Official XMRig computed and submitted a real RandomX share through the gateway${speed ? ` at ${speed} H/s` : ''}.`,
      );
    }

    const bitcoinRpcBase = (process.env.BITCOIN_RPC_URL ?? 'http://127.0.0.1:18443').replace(
      /\/$/u,
      '',
    );
    const bitcoinWalletName = process.env.BITCOIN_WALLET_NAME ?? 'mining-gateway';
    const bitcoinPasswordFile = resolve(
      serverRoot,
      process.env.BITCOIN_RPC_PASSWORD_FILE ?? '../../secrets/bitcoin-rpc-password.txt',
    );
    const bitcoinWalletPassphraseFile = resolve(
      serverRoot,
      process.env.BITCOIN_WALLET_PASSPHRASE_FILE ?? '../../secrets/bitcoin-wallet-passphrase.txt',
    );
    const bitcoinRpc = new JsonRpcClient(
      `${bitcoinRpcBase}/wallet/${encodeURIComponent(bitcoinWalletName)}`,
      process.env.BITCOIN_RPC_USER ?? 'miningrpc',
      () => readFileSync(bitcoinPasswordFile, 'utf8').trim(),
    );
    const miningAddress = await bitcoinRpc.call<string>('getnewaddress', [
      `e2e-mining-${suffix}`,
      'bech32',
    ]);
    await bitcoinRpc.call('generatetoaddress', [101, miningAddress]);
    try {
      await bitcoinRpc.call('walletpassphrase', [
        readFileSync(bitcoinWalletPassphraseFile, 'utf8').trim(),
        30,
      ]);
    } catch (error) {
      if (!(error instanceof RpcError) || !error.message.toLowerCase().includes('unencrypted'))
        throw error;
    }
    try {
      await bitcoinRpc.call('sendtoaddress', [
        receiveAddress.body.address,
        0.01,
        `e2e-deposit-${suffix}`,
      ]);
    } finally {
      await bitcoinRpc.call('walletlock').catch(() => undefined);
    }
    await bitcoinRpc.call('generatetoaddress', [6, miningAddress]);
    await mutate<{ ok: boolean }>('/api/v1/wallets/scan', {});
    const deposits = await api<
      Array<{ id: string; amountAtomic: string; status: string; allocationBatch?: { id: string } }>
    >({ ...session, path: '/api/v1/wallets/deposits?asset=BTC' });
    const deposit = deposits.body.find(
      (item) => item.amountAtomic === '1000000' && item.status === 'ALLOCATED',
    );
    if (!deposit?.allocationBatch?.id)
      throw new Error(`Confirmed BTC deposit was not allocated: ${JSON.stringify(deposits.body)}`);
    await database.query(
      `UPDATE "PayoutDestination"
       SET "status" = 'ACTIVE', "effectiveAt" = NOW() - INTERVAL '1 minute'
       WHERE "id" = $1`,
      [destination.body.id],
    );
    const planned = await mutate<{ id: string; state: string } | null>('/api/v1/payouts/plan', {
      asset: 'BTC',
    });
    if (!planned.body || planned.body.state !== 'AUTO_APPROVED')
      throw new Error(`BTC payout was not auto-approved: ${JSON.stringify(planned.body)}`);
    const executed = await mutate<{ state: string; transactionIds: string[] }>(
      `/api/v1/payouts/${planned.body.id}/execute`,
      {},
    );
    if (executed.body.state !== 'BROADCAST' || executed.body.transactionIds.length !== 1)
      throw new Error(`BTC payout was not broadcast: ${JSON.stringify(executed.body)}`);
    await bitcoinRpc.call('generatetoaddress', [6, miningAddress]);
    await mutate<{ ok: boolean }>('/api/v1/payouts/reconcile', {});
    const payout = await database.query<{ state: string }>(
      `SELECT "state"::text AS state FROM "PayoutBatch" WHERE "id" = $1`,
      [planned.body.id],
    );
    if (payout.rows[0]?.state !== 'CONFIRMED')
      throw new Error(`BTC payout did not confirm: ${JSON.stringify(payout.rows[0])}`);
    const ledger = await database.query<{ imbalance: string }>(`
      SELECT COALESCE(SUM(
        CASE WHEN entry."direction" = 'DEBIT' THEN entry."amountAtomic"
             ELSE -entry."amountAtomic" END
      ), 0)::text AS imbalance
      FROM "JournalEntry" entry
      JOIN "LedgerAccount" account ON account."id" = entry."accountId"
      WHERE account."asset" = 'BTC'
    `);
    if (ledger.rows[0]?.imbalance !== '0')
      throw new Error(`BTC ledger is unbalanced: ${JSON.stringify(ledger.rows[0])}`);
    log(
      '[PASS] BTC regtest deposit, allocation, signed payout, broadcast, confirmation and ledger balance.',
    );
    log(
      'Local mining E2E passed. No real network or coin was used; the temporary database is removed and the local Bitcoin regtest chain is advanced.',
    );
  } catch (error) {
    const payoutFailure = testPool
      ? await testPool
          .query<{
            id: string;
            state: string;
            errorCode: string | null;
            errorMessage: string | null;
          }>(
            `SELECT "id", "state"::text AS state, "errorCode", "errorMessage"
             FROM "PayoutBatch" ORDER BY "createdAt" DESC LIMIT 1`,
          )
          .then((result) => JSON.stringify(result.rows[0] ?? null))
          .catch(() => 'unavailable')
      : 'unavailable';
    throw new Error(
      `${error instanceof Error ? error.stack : String(error)}\nLatest payout: ${payoutFailure}\nGateway output:\n${gatewayOutput.slice(-8000)}`,
    );
  } finally {
    await stopProcess(gateway);
    await Promise.allSettled([
      bitcoinPool.stop(),
      moneroPool.stop(),
      validatingBitcoinPool?.stop() ?? Promise.resolve(),
    ]);
    if (testPool) await testPool.end().catch(() => undefined);
    if (createdDatabase) {
      await adminPool
        .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
        .catch((error: unknown) =>
          process.stderr.write(`Temporary database cleanup failed: ${String(error)}\n`),
        );
    }
    await adminPool.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
