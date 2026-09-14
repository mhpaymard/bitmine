import type { Socket } from 'node:net';
import type { JsonRpcMessage } from './gateway.types';

export type MessageHandler = (message: JsonRpcMessage) => Promise<void>;

export class LineJsonPeer {
  private buffer = Buffer.alloc(0);
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly socket: Socket,
    private readonly maxLineBytes: number,
    private readonly onMessage: MessageHandler,
    private readonly onProtocolError: (error: Error) => void,
  ) {
    socket.on('data', (chunk: Buffer) => this.consume(chunk));
  }

  send(message: JsonRpcMessage): void {
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(`${JSON.stringify(message)}\n`);
    }
  }

  destroy(error?: Error): void {
    this.socket.destroy(error);
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxLineBytes && !this.buffer.includes(0x0a)) {
      this.onProtocolError(new Error('JSON-RPC line exceeds configured limit'));
      return;
    }
    let newline = this.buffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.buffer.subarray(0, newline).toString('utf8').trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length > this.maxLineBytes) {
        this.onProtocolError(new Error('JSON-RPC line exceeds configured limit'));
        return;
      }
      if (line) {
        try {
          const value = JSON.parse(line) as unknown;
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('Message must be an object');
          this.queue = this.queue
            .then(() => this.onMessage(value as JsonRpcMessage))
            .catch((error: unknown) => {
              this.onProtocolError(error instanceof Error ? error : new Error(String(error)));
            });
        } catch (error) {
          this.onProtocolError(
            error instanceof Error ? error : new Error('Invalid JSON-RPC message'),
          );
          return;
        }
      }
      newline = this.buffer.indexOf(0x0a);
    }
  }
}
