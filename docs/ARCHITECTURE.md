# Architecture

## Runtime boundaries

The application is a NestJS 11 modular monolith running manually on Node.js 24. It owns four runtime responsibilities in one process: Fastify REST/SSE, the Bitcoin and Monero TCP listeners, scheduled accounting work, and payout reconciliation. PostgreSQL is the financial source of truth; Redis is disposable infrastructure for sessions, rate state and live connection counters.

Each downstream miner gets a dedicated upstream TCP/TLS connection. This preserves compatibility with public Stratum V1 and Monero pools and avoids unsafe extranonce/job multiplexing. On upstream failure, candidates are ordered by priority and cooldown state. A connection whose job/extranonce cannot be preserved is closed so the miner reconnects cleanly. The gateway never fabricates an accepted share.

## Modules

| Module       | Responsibility                                                                               |
| ------------ | -------------------------------------------------------------------------------------------- |
| `gateway`    | TCP framing, local worker auth, BTC Stratum V1, XMR JSON-RPC, failover, share journal        |
| `customers`  | Customers, workers, one-time credentials, rotation/revocation, policy versions, destinations |
| `upstreams`  | Encrypted pool credentials, priority, TLS and health checks                                  |
| `ledger`     | Exact allocation, largest remainder, append-only double-entry journal                        |
| `wallets`    | Bitcoin Core/Monero RPC, deposits, confirmations, PSBT/transfer preparation                  |
| `payouts`    | Batch planning, TOTP approval, signing, broadcast, crash reconciliation                      |
| `auth/audit` | Redis sessions, CSRF, RBAC, TOTP/recovery codes, hash-chained audit events                   |
| `settings`   | Daily timezone schedule and cooled operator payout configuration                             |

## Data guarantees

- Atomic amounts are PostgreSQL `bigint` and JSON strings; floating-point values are never used for money.
- Share difficulty/work use exact decimal columns.
- A share is inserted as `PENDING` before upstream submission. Database failure therefore stops new economically relevant work.
- A confirmed deposit is locked by an advisory transaction lock, allocated once, and journaled in a serializable transaction.
- Allocation uses accepted, unallocated work for the same upstream. Policy IDs are captured on each share, so later ratio changes do not rewrite history.
- Largest remainder makes customer gross allocations sum exactly to the deposit. The customer/operator split always sums to 10,000 basis points.
- Journal postings enforce equal positive debit and credit totals.
- Signed payout payload and expected txids are persisted before broadcast. On retry the wallet is queried before any rebroadcast.
- Raw shares are rolled into minute/hour/day aggregates. Allocated/rejected/unknown raw rows are pruned after the configured retention period; accepted unallocated rows are never pruned.

## Extension contract

`PoolAdapter` owns asset-specific normalized-work rules. `WalletAdapter` owns validation, deposit discovery, payout preparation/broadcast and transaction lookup. Adding a coin requires a new asset migration, both adapters, protocol fixtures, address/network validation, ledger tests and a separate wallet—never automatic cross-asset conversion.
