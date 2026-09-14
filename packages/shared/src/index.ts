export const ASSET_CODES = ['BTC', 'XMR'] as const;
export type AssetCode = (typeof ASSET_CODES)[number];

export type AtomicAmount = string;
export type SplitBps = number;

export const BASIS_POINTS = 10_000;

export interface SplitPolicyView {
  id: string;
  asset: AssetCode;
  customerBps: SplitBps;
  operatorBps: SplitBps;
  effectiveAt: string;
}

export interface WorkerLiveStats {
  workerId: string;
  asset: AssetCode;
  connected: boolean;
  hashrate1m: number;
  hashrate5m: number;
  hashrate15m: number;
  accepted: string;
  rejected: string;
  lastShareAt: string | null;
  upstreamName: string | null;
}

export interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}
