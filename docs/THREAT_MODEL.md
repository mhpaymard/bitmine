# Threat model

## Assets and trust boundaries

Protected assets are worker tokens, upstream credentials, admin sessions, wallet passphrases/seeds, signed transactions and the financial ledger. The LAN is treated as partially hostile: a compromised miner may send malformed, oversized or high-rate messages. Public pools and the internet are untrusted. PostgreSQL and wallet RPC are trusted only on loopback/private Docker networking.

## Controls

- Worker tokens contain 32 random bytes, are shown once and stored as Argon2id hashes. Rotation overlaps for a bounded grace period; revocation is immediate.
- Worker/customer status, maximum connections and exact/CIDR IP allowlists are checked locally before upstream credentials are exposed.
- TCP input is newline framed with a hard byte limit, idle timeout and ordered asynchronous processing.
- Upstream passwords use AES-256-GCM with context-bound AAD. The master key and all wallet/RPC secrets are files outside Git/DB.
- Admin sessions are random server-side Redis records; cookies are HttpOnly, SameSite=Strict and Secure in production. Mutations require the per-session CSRF header.
- Login uses constant-work password verification for unknown users, five-attempt lockout, TOTP and single-use recovery codes.
- Roles are Owner, Operator and Viewer. Financial approval and security settings require Owner.
- Audit events are append-only in the API and chained with SHA-256 under a PostgreSQL advisory lock. Backups and DB permissions must prevent direct tampering.
- Logs redact authorization, cookies, passwords, tokens and secrets before Loki ingestion.
- Caddy’s LAN profile uses internal TLS and an IP allowlist. The production profile uses an externally issued certificate and must be restricted to a VPN or explicit admin IPs.
- Mainnet signing has a hard environment gate. Default automatic payout limits are zero, forcing Owner+TOTP approval.
- Changing customer or operator withdrawal addresses waits 24 hours.

## Residual risks

Stratum V1 has no end-to-end job authentication and remains vulnerable if the server or upstream DNS/TLS trust is compromised. A hot-wallet host compromise can steal its operational float. A database administrator can alter data below application controls; encrypted, separately retained backups and external reconciliation are required. Pool-side estimated earnings are not authoritative. Legal/custody obligations remain outside the application.

## Production recommendations

Place miners and the gateway on a dedicated VLAN, block miner egress at the router, use a VPN for administration, pin DNS/resolvers, use hardware-backed storage for recovery material, monitor filesystem capacity, and keep the hot-wallet balance below a documented loss limit. Run an independent penetration test before public exposure.
