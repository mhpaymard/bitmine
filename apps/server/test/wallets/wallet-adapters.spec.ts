import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { AssetCode } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Environment } from '../../src/config/environment';
import { BitcoinWalletAdapter } from '../../src/wallets/bitcoin-wallet.adapter';
import { MoneroWalletAdapter } from '../../src/wallets/monero-wallet.adapter';
import { RpcError } from '../../src/wallets/rpc-client';

const secretDirectory = mkdtempSync(join(tmpdir(), 'mitm-wallet-test-'));
const passphraseFile = join(secretDirectory, 'passphrase.txt');
writeFileSync(passphraseFile, 'test-passphrase\n', { encoding: 'utf8', mode: 0o600 });

afterAll(() => rmSync(secretDirectory, { recursive: true, force: true }));

function config(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    BITCOIN_RPC_URL: 'http://127.0.0.1:18443',
    BITCOIN_RPC_USER: 'rpc',
    BITCOIN_RPC_PASSWORD_FILE: passphraseFile,
    BITCOIN_WALLET_NAME: 'gateway wallet',
    BITCOIN_WALLET_PASSPHRASE_FILE: passphraseFile,
    BITCOIN_CONFIRMATIONS: 6,
    BITCOIN_NETWORK: 'regtest',
    MONERO_WALLET_RPC_URL: 'http://127.0.0.1:38088/json_rpc',
    MONERO_WALLET_RPC_USER: 'rpc',
    MONERO_WALLET_RPC_PASSWORD_FILE: passphraseFile,
    MONERO_CONFIRMATIONS: 10,
    MONERO_NETWORK: 'stagenet',
    ENABLE_MAINNET_PAYOUTS: false,
    ...overrides,
  };
  return { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService<
    Environment,
    true
  >;
}

function rpcCall(adapter: object) {
  return vi.spyOn(
    (
      adapter as unknown as {
        rpc: { call: (method: string, params?: unknown) => Promise<unknown> };
      }
    ).rpc,
    'call',
  );
}

describe('Bitcoin wallet adapter', () => {
  it('normalizes only matching positive receive transactions into atomic units', async () => {
    const adapter = new BitcoinWalletAdapter(config());
    rpcCall(adapter).mockResolvedValue([
      {
        category: 'receive',
        address: 'wanted',
        txid: 'tx-1',
        vout: 2,
        amount: 0.00000001,
        confirmations: 5,
      },
      { category: 'send', address: 'wanted', txid: 'tx-2', amount: 1 },
      { category: 'receive', address: 'other', txid: 'tx-3', amount: 1 },
    ]);

    await expect(adapter.scanReceipts(['wanted'])).resolves.toEqual([
      expect.objectContaining({
        asset: AssetCode.BTC,
        txid: 'tx-1',
        outputRef: '2',
        amountAtomic: 1n,
        confirmations: 5,
        locked: true,
      }),
    ]);
  });

  it('prepares, signs, and finalizes a balanced payout without losing atomic units', async () => {
    const adapter = new BitcoinWalletAdapter(config());
    const call = rpcCall(adapter).mockImplementation((method: string) => {
      switch (method) {
        case 'walletcreatefundedpsbt':
          return Promise.resolve({ psbt: 'funded-psbt', fee: 0.000001 });
        case 'walletpassphrase':
        case 'walletlock':
          return Promise.resolve(undefined);
        case 'walletprocesspsbt':
          return Promise.resolve({ psbt: 'signed-psbt', complete: true });
        case 'finalizepsbt':
          return Promise.resolve({ hex: 'signed-hex', complete: true });
        case 'decoderawtransaction':
          return Promise.resolve({ txid: 'stable-txid' });
        default:
          return Promise.reject(new Error(`Unexpected RPC method ${method}`));
      }
    });

    const result = await adapter.preparePayout([
      { id: 'a', address: 'bc1-a', grossAtomic: 600n },
      { id: 'b', address: 'bc1-b', grossAtomic: 400n },
    ]);

    expect(result).toMatchObject({
      signedPayload: 'signed-hex',
      transactionIds: ['stable-txid'],
      feeAtomic: 100n,
    });
    expect(result.items.reduce((sum, item) => sum + item.netAtomic, 0n)).toBe(900n);
    expect(result.items.reduce((sum, item) => sum + item.allocatedFeeAtomic, 0n)).toBe(100n);
    expect(call.mock.calls.map(([method]) => method)).toContain('walletlock');
  });

  it('blocks mainnet broadcast and handles Bitcoin Core transaction-not-found', async () => {
    const blocked = new BitcoinWalletAdapter(
      config({ BITCOIN_NETWORK: 'mainnet', ENABLE_MAINNET_PAYOUTS: false }),
    );
    const blockedCall = rpcCall(blocked);
    await expect(blocked.broadcast('hex')).rejects.toThrow(/mainnet payouts are disabled/u);
    expect(blockedCall).not.toHaveBeenCalled();

    const adapter = new BitcoinWalletAdapter(config());
    rpcCall(adapter).mockRejectedValue(new RpcError('Invalid or non-wallet transaction id', -5));
    await expect(adapter.transactionKnown('missing')).resolves.toBe(false);
    await expect(adapter.transactionConfirmations('missing')).resolves.toBe(0);
  });
});

describe('Monero wallet adapter', () => {
  it('normalizes incoming and pool transfers and respects locked status', async () => {
    const adapter = new MoneroWalletAdapter(config());
    rpcCall(adapter).mockResolvedValue({
      in: [
        {
          address: 'wanted',
          amount: '1200000000000',
          confirmations: 11,
          locked: false,
          txid: 'confirmed',
          subaddr_index: { major: 0, minor: 3 },
        },
      ],
      pool: [
        {
          address: 'wanted',
          amount: 5,
          confirmations: 0,
          locked: true,
          txid: 'pool',
        },
      ],
    });

    const receipts = await adapter.scanReceipts(['wanted']);
    expect(receipts).toEqual([
      expect.objectContaining({ txid: 'confirmed', outputRef: '0:3', locked: false }),
      expect.objectContaining({ txid: 'pool', amountAtomic: 5n, locked: true }),
    ]);
  });

  it('prepares stable metadata and relays every split transaction', async () => {
    const adapter = new MoneroWalletAdapter(config());
    const call = rpcCall(adapter).mockImplementation((method: string, params?: unknown) => {
      if (method === 'transfer_split') {
        return Promise.resolve({
          tx_hash_list: ['expected-txid'],
          tx_metadata_list: ['metadata'],
          fee_list: ['100'],
        });
      }
      if (method === 'relay_tx') {
        expect(params).toEqual({ hex: 'metadata' });
        return Promise.resolve({ tx_hash: 'relayed-txid' });
      }
      return Promise.reject(new Error(`Unexpected RPC method ${method}`));
    });

    const prepared = await adapter.preparePayout([
      { id: 'a', address: 'monero-a', grossAtomic: 700n },
      { id: 'b', address: 'monero-b', grossAtomic: 300n },
    ]);
    expect(prepared.feeAtomic).toBe(100n);
    expect(prepared.items.reduce((sum, item) => sum + item.netAtomic, 0n)).toBe(900n);
    await expect(adapter.broadcast(prepared.signedPayload)).resolves.toEqual(['relayed-txid']);
    expect(call.mock.calls.filter(([method]) => method === 'transfer_split')).toHaveLength(2);
  });

  it('blocks Monero mainnet payouts before calling the wallet', async () => {
    const adapter = new MoneroWalletAdapter(
      config({ MONERO_NETWORK: 'mainnet', ENABLE_MAINNET_PAYOUTS: false }),
    );
    const call = rpcCall(adapter);

    await expect(
      adapter.preparePayout([{ id: 'a', address: 'x', grossAtomic: 10n }]),
    ).rejects.toThrow(/mainnet payouts are disabled/u);
    expect(call).not.toHaveBeenCalled();
  });
});
