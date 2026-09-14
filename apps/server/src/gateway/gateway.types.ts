import type { AssetCode, Customer, SplitPolicyVersion, Upstream, Worker } from '@prisma/client';

export type RpcId = string | number | null;

export interface JsonRpcMessage {
  id?: RpcId;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export interface AuthorizedWorker {
  worker: Worker;
  customer: Customer;
  policy: SplitPolicyVersion;
  connectionLeaseId: string;
}

export interface UpstreamBinding {
  upstream: Upstream;
  username: string;
  password: string;
}

export interface PendingRpc {
  downstreamId: RpcId;
  method: string;
  shareEvent?: ShareReference;
  startedAt: number;
}

export interface ShareReference {
  id: string;
  submittedAt: Date;
}

export interface PoolAdapter {
  readonly asset: AssetCode;
  readonly name: string;
  normalizedWork(difficulty: string): string;
}
