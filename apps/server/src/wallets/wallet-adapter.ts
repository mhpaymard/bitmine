import type { AssetCode } from '@prisma/client';

export interface WalletReceipt {
  asset: AssetCode;
  txid: string;
  outputRef: string;
  address: string;
  amountAtomic: bigint;
  confirmations: number;
  locked: boolean;
  raw: Record<string, unknown>;
}

export interface PayoutCandidate {
  id: string;
  address: string;
  grossAtomic: bigint;
}

export interface PreparedPayout {
  signedPayload: string;
  transactionIds: string[];
  feeAtomic: bigint;
  items: Array<PayoutCandidate & { allocatedFeeAtomic: bigint; netAtomic: bigint }>;
}

export interface PayoutPreparationOptions {
  deductFeeFromOutputs: boolean;
}

export interface WalletAdapter {
  readonly asset: AssetCode;
  createReceiveAddress(label: string): Promise<string>;
  validateAddress(address: string): Promise<boolean>;
  scanReceipts(addresses: string[]): Promise<WalletReceipt[]>;
  preparePayout(
    items: PayoutCandidate[],
    options?: PayoutPreparationOptions,
  ): Promise<PreparedPayout>;
  broadcast(signedPayload: string): Promise<string[]>;
  transactionKnown(txid: string): Promise<boolean>;
  transactionConfirmations(txid: string): Promise<number>;
  status(): Promise<Record<string, unknown>>;
}
