import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { LineJsonPeer } from '../../src/gateway/line-json-peer';
import type { JsonRpcMessage } from '../../src/gateway/gateway.types';

class FakeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  readonly write = vi.fn(() => true);
  destroy(error?: Error) {
    this.destroyed = true;
    if (error) this.emit('error', error);
    return this;
  }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('LineJsonPeer', () => {
  it('reassembles partial frames and processes multiple lines in order', async () => {
    const socket = new FakeSocket();
    const messages: JsonRpcMessage[] = [];
    const errors: Error[] = [];
    new LineJsonPeer(
      socket as unknown as Socket,
      1024,
      (message) => {
        messages.push(message);
        return Promise.resolve();
      },
      (error) => errors.push(error),
    );

    socket.emit('data', Buffer.from('{"id":1,"method":"mining.sub'));
    socket.emit('data', Buffer.from('scribe"}\n{"id":2}\n'));
    await flush();

    expect(messages).toEqual([{ id: 1, method: 'mining.subscribe' }, { id: 2 }]);
    expect(errors).toEqual([]);
  });

  it('rejects malformed and oversized frames', () => {
    const malformedErrors: Error[] = [];
    const first = new FakeSocket();
    new LineJsonPeer(
      first as unknown as Socket,
      64,
      () => Promise.resolve(),
      (error) => malformedErrors.push(error),
    );
    first.emit('data', Buffer.from('{bad}\n'));
    expect(malformedErrors[0]?.message).toMatch(/JSON/u);

    const sizeErrors: Error[] = [];
    const second = new FakeSocket();
    new LineJsonPeer(
      second as unknown as Socket,
      16,
      () => Promise.resolve(),
      (error) => sizeErrors.push(error),
    );
    second.emit('data', Buffer.from('x'.repeat(17)));
    expect(sizeErrors[0]?.message).toMatch(/exceeds/u);
  });

  it('writes one newline-delimited message', () => {
    const socket = new FakeSocket();
    const peer = new LineJsonPeer(
      socket as unknown as Socket,
      128,
      () => Promise.resolve(),
      () => undefined,
    );
    peer.send({ id: 7, result: true });
    expect(socket.write).toHaveBeenCalledWith('{"id":7,"result":true}\n');
  });
});
