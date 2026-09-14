import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeBitcoinPool, FakeMoneroPool } from './fake-pools';

const running: Array<FakeBitcoinPool | FakeMoneroPool> = [];
afterEach(async () => Promise.all(running.splice(0).map((pool) => pool.stop())));

async function exchange(
  port: number,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let buffer = '';
    socket.once('error', reject);
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
    });
  });
}

describe('fake pool test fixtures', () => {
  it('emulates Bitcoin authorization and rejected shares', async () => {
    const pool = new FakeBitcoinPool({ rejectSubmit: true });
    running.push(pool);
    await pool.start();
    await expect(
      exchange(pool.port, { id: 1, method: 'mining.authorize', params: ['worker', 'secret'] }),
    ).resolves.toMatchObject({ result: true });
    await expect(
      exchange(pool.port, { id: 2, method: 'mining.submit', params: [] }),
    ).resolves.toMatchObject({ result: false });
  });

  it('emulates a Monero login job', async () => {
    const pool = new FakeMoneroPool();
    running.push(pool);
    await pool.start();
    const response = await exchange(pool.port, {
      id: 1,
      method: 'login',
      params: { login: 'worker', pass: 'secret' },
    });
    expect(response).toMatchObject({ result: { status: 'OK', job: { job_id: 'fake-job' } } });
  });
});
