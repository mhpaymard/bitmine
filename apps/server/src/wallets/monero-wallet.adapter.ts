import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetCode } from '@prisma/client';
import type { Environment } from '../config/environment';
import { readSecretFile } from '../config/environment';
import { largestRemainder } from '../ledger/allocation';
import type {
  PayoutCandidate,
  PayoutPreparationOptions,
  PreparedPayout,
  WalletAdapter,
  WalletReceipt,
} from './wallet-adapter';
import { JsonRpcClient } from './rpc-client';

interface MoneroTransfer {
  address?: string;
  amount: number | string;
  confirmations?: number;
  txid: string;
  locked?: boolean;
  subaddr_index?: { major: number; minor: number };
  height?: number;
}

interface TransferSplitResult {
  tx_hash_list?: string[];
  tx_metadata_list?: string[];
  fee_list?: Array<number | string>;
}

@Injectable()
export class MoneroWalletAdapter implements WalletAdapter {
  readonly asset = AssetCode.XMR;
  private readonly rpc: JsonRpcClient;

  constructor(private readonly config: ConfigService<Environment, true>) {
    this.rpc = new JsonRpcClient(
      config.get('MONERO_WALLET_RPC_URL', { infer: true }),
      config.get('MONERO_WALLET_RPC_USER', { infer: true }),
      () => readSecretFile(config.get('MONERO_WALLET_RPC_PASSWORD_FILE', { infer: true })),
      'digest',
    );
  }

  async createReceiveAddress(label: string): Promise<string> {
    const result = await this.rpc.call<{ address: string }>('create_address', {
      account_index: 0,
      label,
    });
    return result.address;
  }

  async validateAddress(address: string): Promise<boolean> {
    const result = await this.rpc.call<{ valid: boolean }>('validate_address', {
      address,
      any_net_type: false,
      allow_openalias: false,
    });
    return result.valid;
  }

  async scanReceipts(addresses: string[]): Promise<WalletReceipt[]> {
    if (!addresses.length) return [];
    const allow = new Set(addresses);
    const result = await this.rpc.call<{ in?: MoneroTransfer[]; pool?: MoneroTransfer[] }>(
      'get_transfers',
      {
        in: true,
        pool: true,
      },
    );
    return [...(result.in ?? []), ...(result.pool ?? [])]
      .filter(
        (transfer) =>
          transfer.address && allow.has(transfer.address) && BigInt(transfer.amount) > 0n,
      )
      .map((transfer) => ({
        asset: AssetCode.XMR,
        txid: transfer.txid,
        outputRef: `${transfer.subaddr_index?.major ?? 0}:${transfer.subaddr_index?.minor ?? 0}`,
        address: transfer.address!,
        amountAtomic: BigInt(transfer.amount),
        confirmations: transfer.confirmations ?? 0,
        locked:
          transfer.locked !== false ||
          (transfer.confirmations ?? 0) < this.config.get('MONERO_CONFIRMATIONS', { infer: true }),
        raw: transfer as unknown as Record<string, unknown>,
      }));
  }

  async preparePayout(
    items: PayoutCandidate[],
    options: PayoutPreparationOptions = { deductFeeFromOutputs: true },
  ): Promise<PreparedPayout> {
    if (!items.length) throw new Error('Payout has no items');
    this.assertMainnetAllowed();
    const preliminary = await this.transferSplit(
      items.map((item) => ({ address: item.address, amount: item.grossAtomic.toString() })),
    );
    let feeAtomic = (preliminary.fee_list ?? []).reduce((sum, fee) => sum + BigInt(fee), 0n);
    let netItems: PreparedPayout['items'] = [];
    let prepared: TransferSplitResult | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const fees = largestRemainder(
        feeAtomic,
        items.map((item) => ({ key: item.id, weight: item.grossAtomic.toString() })),
      );
      const feeMap = new Map(fees.map((fee) => [fee.key, fee.amount]));
      netItems = items.map((item) => {
        const allocatedFeeAtomic = feeMap.get(item.id) ?? 0n;
        if (options.deductFeeFromOutputs && allocatedFeeAtomic >= item.grossAtomic)
          throw new Error(`Payout ${item.id} is smaller than its fee`);
        return {
          ...item,
          allocatedFeeAtomic,
          netAtomic: options.deductFeeFromOutputs
            ? item.grossAtomic - allocatedFeeAtomic
            : item.grossAtomic,
        };
      });
      prepared = await this.transferSplit(
        netItems.map((item) => ({ address: item.address, amount: item.netAtomic.toString() })),
      );
      const actualFee = (prepared.fee_list ?? []).reduce((sum, fee) => sum + BigInt(fee), 0n);
      if (actualFee === feeAtomic) break;
      feeAtomic = actualFee;
      prepared = undefined;
    }
    if (!prepared) throw new Error('Monero payout fee did not converge');
    const metadata = prepared.tx_metadata_list ?? [];
    if (!metadata.length) throw new Error('Monero wallet did not return transaction metadata');
    const transactionIds = prepared.tx_hash_list ?? [];
    if (transactionIds.length !== metadata.length)
      throw new Error('Monero wallet did not return stable transaction IDs');
    return {
      signedPayload: JSON.stringify({ metadata, transactionIds }),
      transactionIds,
      feeAtomic,
      items: netItems,
    };
  }

  async broadcast(signedPayload: string): Promise<string[]> {
    this.assertMainnetAllowed();
    const payload = JSON.parse(signedPayload) as { metadata: string[]; transactionIds: string[] };
    const txids: string[] = [];
    for (const [index, hex] of payload.metadata.entries()) {
      const result = await this.rpc.call<{ tx_hash?: string }>('relay_tx', { hex });
      const txid = result.tx_hash ?? payload.transactionIds[index];
      if (!txid) throw new Error('Monero wallet relay did not return a transaction ID');
      txids.push(txid);
    }
    return txids;
  }

  async transactionKnown(txid: string): Promise<boolean> {
    const result = await this.rpc.call<{
      in?: MoneroTransfer[];
      out?: MoneroTransfer[];
      pending?: MoneroTransfer[];
      pool?: MoneroTransfer[];
    }>('get_transfers', { in: true, out: true, pending: true, pool: true });
    return [
      ...(result.in ?? []),
      ...(result.out ?? []),
      ...(result.pending ?? []),
      ...(result.pool ?? []),
    ].some((transaction) => transaction.txid === txid);
  }

  async transactionConfirmations(txid: string): Promise<number> {
    const result = await this.rpc.call<{
      in?: MoneroTransfer[];
      out?: MoneroTransfer[];
      pending?: MoneroTransfer[];
    }>('get_transfers', { in: true, out: true, pending: true });
    const transaction = [
      ...(result.in ?? []),
      ...(result.out ?? []),
      ...(result.pending ?? []),
    ].find((item) => item.txid === txid);
    return transaction?.confirmations ?? 0;
  }

  async status(): Promise<Record<string, unknown>> {
    const [height, balance, version] = await Promise.all([
      this.rpc.call<Record<string, unknown>>('get_height'),
      this.rpc.call<Record<string, unknown>>('get_balance', { account_index: 0 }),
      this.rpc.call<Record<string, unknown>>('get_version'),
    ]);
    return { height, balance, version };
  }

  private transferSplit(
    destinations: Array<{ address: string; amount: string }>,
  ): Promise<TransferSplitResult> {
    return this.rpc.call<TransferSplitResult>('transfer_split', {
      destinations,
      account_index: 0,
      priority: 0,
      get_tx_keys: true,
      do_not_relay: true,
      get_tx_hex: true,
      get_tx_metadata: true,
    });
  }

  private assertMainnetAllowed(): void {
    if (
      this.config.get('MONERO_NETWORK', { infer: true }) === 'mainnet' &&
      !this.config.get('ENABLE_MAINNET_PAYOUTS', { infer: true })
    ) {
      throw new Error('Monero mainnet payouts are disabled by ENABLE_MAINNET_PAYOUTS');
    }
  }
}
