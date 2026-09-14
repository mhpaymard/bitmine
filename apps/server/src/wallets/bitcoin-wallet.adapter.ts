import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetCode } from '@prisma/client';
import Decimal from 'decimal.js';
import type { Environment } from '../config/environment';
import { readSecretFile } from '../config/environment';
import { largestRemainder } from '../ledger/allocation';
import type {
  PayoutCandidate,
  PreparedPayout,
  WalletAdapter,
  WalletReceipt,
} from './wallet-adapter';
import { JsonRpcClient, RpcError } from './rpc-client';

interface BitcoinTransaction {
  address?: string;
  category?: string;
  amount?: number;
  confirmations?: number;
  txid?: string;
  vout?: number;
  blockhash?: string;
  time?: number;
}

@Injectable()
export class BitcoinWalletAdapter implements WalletAdapter {
  readonly asset = AssetCode.BTC;
  private readonly rpc: JsonRpcClient;

  constructor(private readonly config: ConfigService<Environment, true>) {
    const base = config.get('BITCOIN_RPC_URL', { infer: true }).replace(/\/$/u, '');
    const wallet = encodeURIComponent(config.get('BITCOIN_WALLET_NAME', { infer: true }));
    this.rpc = new JsonRpcClient(
      `${base}/wallet/${wallet}`,
      config.get('BITCOIN_RPC_USER', { infer: true }),
      () => readSecretFile(config.get('BITCOIN_RPC_PASSWORD_FILE', { infer: true })),
    );
  }

  createReceiveAddress(label: string): Promise<string> {
    return this.rpc.call<string>('getnewaddress', [label, 'bech32']);
  }

  async validateAddress(address: string): Promise<boolean> {
    const result = await this.rpc.call<{ isvalid: boolean }>('validateaddress', [address]);
    return result.isvalid;
  }

  async scanReceipts(addresses: string[]): Promise<WalletReceipt[]> {
    if (!addresses.length) return [];
    const allow = new Set(addresses);
    const transactions = await this.rpc.call<BitcoinTransaction[]>('listtransactions', [
      '*',
      5000,
      0,
      true,
    ]);
    return transactions
      .filter(
        (tx) =>
          tx.category === 'receive' &&
          tx.address &&
          allow.has(tx.address) &&
          tx.txid &&
          (tx.amount ?? 0) > 0,
      )
      .map((tx) => ({
        asset: AssetCode.BTC,
        txid: tx.txid!,
        outputRef: String(tx.vout ?? 0),
        address: tx.address!,
        amountAtomic: BigInt(new Decimal(tx.amount ?? 0).mul(100_000_000).toFixed(0)),
        confirmations: tx.confirmations ?? 0,
        locked: (tx.confirmations ?? 0) < this.config.get('BITCOIN_CONFIRMATIONS', { infer: true }),
        raw: tx as Record<string, unknown>,
      }));
  }

  private outputs(
    items: Array<{ address: string; amountAtomic: bigint }>,
  ): Array<Record<string, number>> {
    return items.map((item) => ({
      [item.address]: Number(new Decimal(item.amountAtomic.toString()).div(100_000_000).toFixed(8)),
    }));
  }

  async preparePayout(items: PayoutCandidate[]): Promise<PreparedPayout> {
    if (!items.length) throw new Error('Payout has no items');
    this.assertMainnetAllowed();
    const preliminary = await this.rpc.call<{ psbt: string; fee: number }>(
      'walletcreatefundedpsbt',
      [
        [],
        this.outputs(
          items.map((item) => ({ address: item.address, amountAtomic: item.grossAtomic })),
        ),
        0,
        { add_inputs: true, lockUnspents: false, replaceable: true },
        true,
      ],
    );
    let feeAtomic = BigInt(new Decimal(preliminary.fee).mul(100_000_000).ceil().toFixed(0));
    let netItems: PreparedPayout['items'] = [];
    let funded: { psbt: string; fee: number } | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fees = largestRemainder(
        feeAtomic,
        items.map((item) => ({ key: item.id, weight: item.grossAtomic.toString() })),
      );
      const feeMap = new Map(fees.map((fee) => [fee.key, fee.amount]));
      netItems = items.map((item) => {
        const allocatedFeeAtomic = feeMap.get(item.id) ?? 0n;
        if (allocatedFeeAtomic >= item.grossAtomic)
          throw new Error(`Payout ${item.id} is smaller than its fee`);
        return { ...item, allocatedFeeAtomic, netAtomic: item.grossAtomic - allocatedFeeAtomic };
      });
      funded = await this.rpc.call<{ psbt: string; fee: number }>('walletcreatefundedpsbt', [
        [],
        this.outputs(
          netItems.map((item) => ({ address: item.address, amountAtomic: item.netAtomic })),
        ),
        0,
        { add_inputs: true, lockUnspents: false, replaceable: true },
        true,
      ]);
      const actualFee = BigInt(new Decimal(funded.fee).mul(100_000_000).ceil().toFixed(0));
      if (actualFee === feeAtomic) break;
      feeAtomic = actualFee;
      funded = undefined;
    }
    if (!funded) throw new Error('Bitcoin payout fee did not converge');
    await this.unlock();
    try {
      const processed = await this.rpc.call<{ psbt: string; complete: boolean }>(
        'walletprocesspsbt',
        [funded.psbt, true, 'ALL', true],
      );
      if (!processed.complete) throw new Error('Bitcoin Core did not fully sign the payout PSBT');
      const finalized = await this.rpc.call<{ hex: string; complete: boolean }>('finalizepsbt', [
        processed.psbt,
        true,
      ]);
      if (!finalized.complete || !finalized.hex)
        throw new Error('Bitcoin Core did not finalize the payout PSBT');
      const decoded = await this.rpc.call<{ txid: string }>('decoderawtransaction', [
        finalized.hex,
      ]);
      return {
        signedPayload: finalized.hex,
        transactionIds: [decoded.txid],
        feeAtomic,
        items: netItems,
      };
    } finally {
      await this.rpc.call('walletlock').catch(() => undefined);
    }
  }

  async broadcast(signedPayload: string): Promise<string[]> {
    this.assertMainnetAllowed();
    const txid = await this.rpc.call<string>('sendrawtransaction', [signedPayload]);
    return [txid];
  }

  async transactionKnown(txid: string): Promise<boolean> {
    try {
      await this.rpc.call('gettransaction', [txid, true, true]);
      return true;
    } catch (error) {
      if (error instanceof RpcError && error.code === -5) return false;
      throw error;
    }
  }

  async transactionConfirmations(txid: string): Promise<number> {
    try {
      const result = await this.rpc.call<{ confirmations?: number }>('gettransaction', [
        txid,
        true,
        true,
      ]);
      return result.confirmations ?? 0;
    } catch (error) {
      if (error instanceof RpcError && error.code === -5) return 0;
      throw error;
    }
  }

  async status(): Promise<Record<string, unknown>> {
    const [chain, wallet, balances] = await Promise.all([
      this.rpc.call<Record<string, unknown>>('getblockchaininfo'),
      this.rpc.call<Record<string, unknown>>('getwalletinfo'),
      this.rpc.call<Record<string, unknown>>('getbalances'),
    ]);
    return { chain, wallet, balances };
  }

  private async unlock(): Promise<void> {
    const passphrase = readSecretFile(
      this.config.get('BITCOIN_WALLET_PASSPHRASE_FILE', { infer: true }),
    );
    try {
      await this.rpc.call('walletpassphrase', [passphrase, 15]);
    } catch (error) {
      if (!(error instanceof RpcError) || !error.message.toLowerCase().includes('unencrypted'))
        throw error;
    }
  }

  private assertMainnetAllowed(): void {
    if (
      this.config.get('BITCOIN_NETWORK', { infer: true }) === 'mainnet' &&
      !this.config.get('ENABLE_MAINNET_PAYOUTS', { infer: true })
    ) {
      throw new Error('Bitcoin mainnet payouts are disabled by ENABLE_MAINNET_PAYOUTS');
    }
  }
}
