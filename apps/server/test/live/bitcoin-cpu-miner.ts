import { createHash, randomBytes } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';

type JsonObject = Record<string, unknown>;

const DIFF_ONE_TARGET = BigInt(
  '0x00000000ffff0000000000000000000000000000000000000000000000000000',
);
const MAX_TARGET = (1n << 256n) - 1n;

interface BitcoinJob {
  id: string;
  previousHash: string;
  coinbaseOne: string;
  coinbaseTwo: string;
  merkleBranches: string[];
  version: string;
  bits: string;
  time: string;
}

export interface CpuMiningResult {
  accepted: number;
  difficulty: number;
  elapsedMs: number;
  hashes: number;
  hashesPerSecond: number;
  jobId: string;
}

function sha256d(value: Buffer): Buffer {
  return createHash('sha256').update(createHash('sha256').update(value).digest()).digest();
}

function reverseHex(value: string): Buffer {
  return Buffer.from(value, 'hex').reverse();
}

function numericHash(hash: Buffer): bigint {
  return BigInt(`0x${Buffer.from(hash).reverse().toString('hex')}`);
}

function targetForDifficulty(difficulty: number): bigint {
  if (!Number.isFinite(difficulty) || difficulty <= 0) throw new Error('Invalid difficulty');
  const scale = 1_000_000_000n;
  const scaledDifficulty = BigInt(Math.max(1, Math.round(difficulty * Number(scale))));
  const target = (DIFF_ONE_TARGET * scale) / scaledDifficulty;
  return target > MAX_TARGET ? MAX_TARGET : target;
}

function coinbaseHash(job: BitcoinJob, extranonceOne: string, extranonceTwo: string): Buffer {
  return sha256d(
    Buffer.from(`${job.coinbaseOne}${extranonceOne}${extranonceTwo}${job.coinbaseTwo}`, 'hex'),
  );
}

function merkleRoot(job: BitcoinJob, coinbase: Buffer): Buffer {
  return job.merkleBranches.reduce(
    (root, branch) => sha256d(Buffer.concat([root, Buffer.from(branch, 'hex')])),
    coinbase,
  );
}

function blockHeader(
  job: BitcoinJob,
  extranonceOne: string,
  extranonceTwo: string,
  nonce: number,
): Buffer {
  const header = Buffer.concat([
    reverseHex(job.version),
    reverseHex(job.previousHash),
    Buffer.from(merkleRoot(job, coinbaseHash(job, extranonceOne, extranonceTwo))).reverse(),
    reverseHex(job.time),
    reverseHex(job.bits),
    Buffer.alloc(4),
  ]);
  header.writeUInt32LE(nonce, 76);
  return header;
}

function parseJob(message: JsonObject): BitcoinJob | undefined {
  if (message.method !== 'mining.notify' || !Array.isArray(message.params)) return undefined;
  const params = message.params;
  if (
    typeof params[0] !== 'string' ||
    typeof params[1] !== 'string' ||
    typeof params[2] !== 'string' ||
    typeof params[3] !== 'string' ||
    !Array.isArray(params[4]) ||
    !params[4].every((value) => typeof value === 'string') ||
    typeof params[5] !== 'string' ||
    typeof params[6] !== 'string' ||
    typeof params[7] !== 'string'
  )
    return undefined;
  return {
    id: params[0],
    previousHash: params[1],
    coinbaseOne: params[2],
    coinbaseTwo: params[3],
    merkleBranches: params[4],
    version: params[5],
    bits: params[6],
    time: params[7],
  };
}

function stratumPeer(socket: Socket) {
  const messages: JsonObject[] = [];
  const waiters: Array<() => void> = [];
  let buffer = '';
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line) as JsonObject);
      waiters.shift()?.();
    }
  });
  return {
    send(message: JsonObject) {
      socket.write(`${JSON.stringify(message)}\n`);
    },
    async next(
      predicate: (message: JsonObject) => boolean,
      timeoutMs = 10_000,
    ): Promise<JsonObject> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) return messages.splice(index, 1)[0]!;
        await new Promise<void>((resolveWait, reject) => {
          const timer = setTimeout(
            () => {
              const waiterIndex = waiters.indexOf(wake);
              if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
              reject(new Error('Timed out waiting for Stratum message'));
            },
            Math.max(1, deadline - Date.now()),
          );
          const wake = () => {
            clearTimeout(timer);
            resolveWait();
          };
          waiters.push(wake);
        });
      }
      throw new Error('Timed out waiting for Stratum message');
    },
  };
}

async function tcpSocket(port: number): Promise<Socket> {
  return new Promise<Socket>((resolveSocket, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolveSocket(socket));
    socket.once('error', reject);
  });
}

export async function mineBitcoinCpu(input: {
  port: number;
  username: string;
  password: string;
  acceptedShares: number;
  maxMiningMs: number;
  submitShares?: boolean;
}): Promise<CpuMiningResult> {
  const socket = await tcpSocket(input.port);
  const peer = stratumPeer(socket);
  try {
    peer.send({ id: 1, method: 'mining.subscribe', params: ['gateway-cpu-sha256d/1.0'] });
    const subscribed = await peer.next((message) => message.id === 1);
    if (!Array.isArray(subscribed.result))
      throw new Error(`Bitcoin subscription failed: ${JSON.stringify(subscribed)}`);
    const extranonceOne = String(subscribed.result[1] ?? '');
    const extranonceSize = Number(subscribed.result[2] ?? 0);
    if (!/^[0-9a-f]+$/iu.test(extranonceOne) || extranonceSize <= 0)
      throw new Error('Upstream returned an invalid extranonce');

    peer.send({
      id: 2,
      method: 'mining.authorize',
      params: [input.username, input.password],
    });
    const authorized = await peer.next((message) => message.id === 2);
    if (authorized.result !== true)
      throw new Error(`Bitcoin authorization failed: ${JSON.stringify(authorized)}`);
    const difficultyMessage = await peer.next(
      (message) => message.method === 'mining.set_difficulty',
    );
    const difficulty = Number(
      Array.isArray(difficultyMessage.params) ? difficultyMessage.params[0] : Number.NaN,
    );
    const jobMessage = await peer.next((message) => message.method === 'mining.notify');
    const job = parseJob(jobMessage);
    if (!job) throw new Error(`Invalid mining job: ${JSON.stringify(jobMessage)}`);

    const target = targetForDifficulty(difficulty);
    const started = performance.now();
    let hashes = 0;
    let accepted = 0;
    let extranonceCounter = 0;
    let nonce = 0;
    const submitShares = input.submitShares ?? true;
    while (
      performance.now() - started < input.maxMiningMs &&
      (!submitShares || accepted < input.acceptedShares)
    ) {
      const extranonceTwo = extranonceCounter.toString(16).padStart(extranonceSize * 2, '0');
      const hash = sha256d(blockHeader(job, extranonceOne, extranonceTwo, nonce));
      hashes += 1;
      if (submitShares && numericHash(hash) <= target) {
        const requestId = 100 + accepted;
        peer.send({
          id: requestId,
          method: 'mining.submit',
          params: [
            input.username,
            job.id,
            extranonceTwo,
            job.time,
            nonce.toString(16).padStart(8, '0'),
          ],
        });
        const submitted = await peer.next((message) => message.id === requestId);
        if (submitted.result !== true)
          throw new Error(`Computed Bitcoin share was rejected: ${JSON.stringify(submitted)}`);
        accepted += 1;
        extranonceCounter += 1;
        nonce = 0;
        continue;
      }
      nonce = (nonce + 1) >>> 0;
      if (nonce % 50_000 === 0)
        await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    }
    const elapsedMs = performance.now() - started;
    if (submitShares && accepted < input.acceptedShares)
      throw new Error(
        `CPU miner timed out after ${hashes} hashes with ${accepted}/${input.acceptedShares} shares`,
      );
    return {
      accepted,
      difficulty,
      elapsedMs,
      hashes,
      hashesPerSecond: hashes / (elapsedMs / 1000),
      jobId: job.id,
    };
  } finally {
    socket.end();
  }
}

export class ValidatingBitcoinPool {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly duplicates = new Set<string>();
  private portValue = 0;
  readonly messages: JsonObject[] = [];
  acceptedShares = 0;
  rejectedShares = 0;
  readonly difficulty = 0.0001;
  private readonly extranonceOne = randomBytes(4).toString('hex');
  private readonly job: BitcoinJob = {
    id: randomBytes(8).toString('hex'),
    previousHash: randomBytes(32).toString('hex'),
    coinbaseOne: `0100000001${'00'.repeat(32)}ffffffff08`,
    coinbaseTwo: 'ffffffff010000000000000000015100000000',
    merkleBranches: [],
    version: '20000000',
    bits: '207fffff',
    time: Math.floor(Date.now() / 1000)
      .toString(16)
      .padStart(8, '0'),
  };

  constructor() {
    this.server = createServer((socket) => this.accept(socket));
  }

  get port(): number {
    return this.portValue;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Pool failed to bind');
    this.portValue = address.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private write(socket: Socket, message: JsonObject): void {
    socket.write(`${JSON.stringify(message)}\n`);
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as JsonObject;
        this.messages.push(message);
        this.respond(socket, message);
      }
    });
  }

  private respond(socket: Socket, message: JsonObject): void {
    const id = message.id ?? null;
    if (message.method === 'mining.subscribe') {
      this.write(socket, {
        id,
        result: [[['mining.notify', 'sha256d-validation']], this.extranonceOne, 4],
        error: null,
      });
      return;
    }
    if (message.method === 'mining.authorize') {
      this.write(socket, { id, result: true, error: null });
      this.write(socket, { id: null, method: 'mining.set_difficulty', params: [this.difficulty] });
      this.write(socket, {
        id: null,
        method: 'mining.notify',
        params: [
          this.job.id,
          this.job.previousHash,
          this.job.coinbaseOne,
          this.job.coinbaseTwo,
          this.job.merkleBranches,
          this.job.version,
          this.job.bits,
          this.job.time,
          true,
        ],
      });
      return;
    }
    if (message.method === 'mining.submit') {
      const valid = this.validateShare(message);
      if (valid) this.acceptedShares += 1;
      else this.rejectedShares += 1;
      this.write(
        socket,
        valid
          ? { id, result: true, error: null }
          : { id, result: false, error: [23, 'low difficulty or duplicate share', null] },
      );
      return;
    }
    this.write(socket, { id, result: null, error: null });
  }

  private validateShare(message: JsonObject): boolean {
    if (!Array.isArray(message.params)) return false;
    const params: unknown[] = message.params;
    const jobId = params[1];
    const extranonceTwo = params[2];
    const time = params[3];
    const nonceHex = params[4];
    if (
      jobId !== this.job.id ||
      typeof extranonceTwo !== 'string' ||
      !/^[0-9a-f]{8}$/iu.test(extranonceTwo) ||
      time !== this.job.time ||
      typeof nonceHex !== 'string' ||
      !/^[0-9a-f]{8}$/iu.test(nonceHex)
    )
      return false;
    const duplicateKey = `${extranonceTwo}:${nonceHex}`;
    if (this.duplicates.has(duplicateKey)) return false;
    this.duplicates.add(duplicateKey);
    const nonce = Number.parseInt(nonceHex, 16);
    const hash = sha256d(blockHeader(this.job, this.extranonceOne, extranonceTwo, nonce));
    return numericHash(hash) <= targetForDifficulty(this.difficulty);
  }
}
