import Decimal from 'decimal.js';
import { AssetCode } from '@prisma/client';
import type { PoolAdapter } from './gateway.types';

export class BitcoinPoolAdapter implements PoolAdapter {
  readonly asset = AssetCode.BTC;
  readonly name = 'Bitcoin Stratum V1';

  normalizedWork(difficulty: string): string {
    return new Decimal(difficulty).mul('4294967296').toFixed(18);
  }
}

export class MoneroPoolAdapter implements PoolAdapter {
  readonly asset = AssetCode.XMR;
  readonly name = 'Monero JSON-RPC';

  normalizedWork(difficulty: string): string {
    return new Decimal(difficulty).toFixed(18);
  }

  difficultyFromTarget(target: string): string {
    const clean = target.replace(/^0x/u, '');
    if (!/^[0-9a-fA-F]+$/u.test(clean) || clean.length % 2 !== 0) return '1';
    const bytes = Buffer.from(clean, 'hex');
    const reversed = Buffer.from(bytes).reverse();
    const value = BigInt(`0x${reversed.toString('hex') || '1'}`);
    if (value <= 0n) return '1';
    const max = (1n << BigInt(bytes.length * 8)) - 1n;
    const difficulty = max / value;
    return (difficulty > 0n ? difficulty : 1n).toString();
  }
}
