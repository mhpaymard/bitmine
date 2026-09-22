import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((value) => value === 'true');

const boolDefaultTrue = z
  .string()
  .default('true')
  .transform((value) => value === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NODE_TLS_REJECT_UNAUTHORIZED: z.string().optional(),
  HTTP_HOST: z.string().default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ADMIN_ORIGIN: z.string().default('http://127.0.0.1:5173'),
  TRUST_PROXY: z.string().default('127.0.0.1,::1,172.16.0.0/12'),
  ALLOW_PUBLIC_HTTP_API_IN_PRODUCTION: bool,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_ENCRYPTION_KEY_FILE: z.string().default('../../secrets/app-encryption.key'),
  COOKIE_SECRET_FILE: z.string().default('../../secrets/cookie-secret.txt'),
  BITCOIN_GATEWAY_HOST: z.string().default('0.0.0.0'),
  BITCOIN_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3333),
  BITCOIN_GATEWAY_TCP_ENABLED: boolDefaultTrue,
  BITCOIN_GATEWAY_TLS_ENABLED: bool,
  BITCOIN_GATEWAY_TLS_HOST: z.string().default('0.0.0.0'),
  BITCOIN_GATEWAY_TLS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
  BITCOIN_GATEWAY_TLS_CERT_FILE: z.string().default('../../secrets/stratum-tls-cert.pem'),
  BITCOIN_GATEWAY_TLS_KEY_FILE: z.string().default('../../secrets/stratum-tls-key.pem'),
  MONERO_GATEWAY_HOST: z.string().default('0.0.0.0'),
  MONERO_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4444),
  MONERO_GATEWAY_TCP_ENABLED: boolDefaultTrue,
  MONERO_GATEWAY_TLS_ENABLED: bool,
  MONERO_GATEWAY_TLS_HOST: z.string().default('0.0.0.0'),
  MONERO_GATEWAY_TLS_PORT: z.coerce.number().int().min(1).max(65535).default(4443),
  MONERO_GATEWAY_TLS_CERT_FILE: z.string().default('../../secrets/stratum-tls-cert.pem'),
  MONERO_GATEWAY_TLS_KEY_FILE: z.string().default('../../secrets/stratum-tls-key.pem'),
  GATEWAY_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(10_000).default(500),
  GATEWAY_MAX_CONNECTIONS_PER_IP: z.coerce.number().int().min(1).max(10_000).default(100),
  GATEWAY_MAX_UNAUTHENTICATED_PER_IP: z.coerce.number().int().min(1).max(1_000).default(10),
  GATEWAY_AUTH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  GATEWAY_MAX_LINE_BYTES: z.coerce.number().int().min(1024).max(1_048_576).default(65_536),
  GATEWAY_IDLE_TIMEOUT_MS: z.coerce.number().int().min(10_000).default(180_000),
  GATEWAY_ENABLED: bool,
  GATEWAY_AUTO_PROVISION_ENABLED: bool,
  GATEWAY_AUTO_PROVISION_CUSTOMER_BPS: z.coerce.number().int().min(0).max(10_000).default(8000),
  GATEWAY_AUTO_PROVISION_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(100).default(4),
  GATEWAY_AUTO_PROVISION_MAX_PER_IP_PER_HOUR: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000)
    .default(20),
  ALLOW_PLAINTEXT_GATEWAY_IN_PRODUCTION: bool,
  RAW_SHARE_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  PAYOUT_TIMEZONE: z.string().default('Asia/Tehran'),
  ENABLE_MAINNET_PAYOUTS: bool,
  BITCOIN_NETWORK: z.enum(['mainnet', 'testnet', 'signet', 'regtest']).default('regtest'),
  BITCOIN_RPC_URL: z.string().url().default('http://127.0.0.1:18443'),
  BITCOIN_RPC_USER: z.string().default('miningrpc'),
  BITCOIN_RPC_PASSWORD_FILE: z.string().default('../../secrets/bitcoin-rpc-password.txt'),
  BITCOIN_WALLET_NAME: z.string().default('mining-gateway'),
  BITCOIN_WALLET_PASSPHRASE_FILE: z.string().default('../../secrets/bitcoin-wallet-passphrase.txt'),
  BITCOIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(6),
  BITCOIN_MIN_PAYOUT_ATOMIC: z.coerce.bigint().default(50_000n),
  BITCOIN_DAILY_AUTO_LIMIT_ATOMIC: z.coerce.bigint().default(0n),
  MONERO_NETWORK: z.enum(['mainnet', 'stagenet', 'testnet']).default('stagenet'),
  MONERO_WALLET_RPC_URL: z.string().url().default('http://127.0.0.1:38088/json_rpc'),
  MONERO_WALLET_RPC_USER: z.string().default('miningrpc'),
  MONERO_WALLET_RPC_PASSWORD_FILE: z.string().default('../../secrets/monero-rpc-password.txt'),
  MONERO_WALLET_PASSPHRASE_FILE: z.string().default('../../secrets/monero-wallet-passphrase.txt'),
  MONERO_CONFIRMATIONS: z.coerce.number().int().min(1).default(10),
  MONERO_MIN_PAYOUT_ATOMIC: z.coerce.bigint().default(10_000_000_000n),
  MONERO_DAILY_AUTO_LIMIT_ATOMIC: z.coerce.bigint().default(0n),
  LOG_LEVEL: z.string().default('info'),
  SERVE_ADMIN_STATIC: bool,
});

export type Environment = z.infer<typeof schema>;

export function validateEnvironment(input: Record<string, unknown>): Environment {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid environment: ${z.prettifyError(result.error)}`);
  }
  if (
    result.data.ENABLE_MAINNET_PAYOUTS &&
    result.data.BITCOIN_NETWORK !== 'mainnet' &&
    result.data.MONERO_NETWORK !== 'mainnet'
  ) {
    throw new Error('ENABLE_MAINNET_PAYOUTS is set but no wallet is configured for mainnet');
  }
  if (result.data.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden');
  }
  if (
    result.data.NODE_ENV === 'production' &&
    !result.data.ALLOW_PUBLIC_HTTP_API_IN_PRODUCTION &&
    !new Set(['127.0.0.1', '::1', 'localhost']).has(result.data.HTTP_HOST)
  ) {
    throw new Error('The production HTTP API must bind to loopback unless explicitly allowed');
  }
  if (result.data.NODE_ENV === 'production') {
    for (const origin of result.data.ADMIN_ORIGIN.split(',').map((value) => value.trim())) {
      const url = new URL(origin);
      if (
        url.protocol !== 'https:' &&
        !new Set(['127.0.0.1', '::1', 'localhost']).has(url.hostname)
      )
        throw new Error('Production admin origins must use HTTPS');
    }
  }
  if (
    result.data.NODE_ENV === 'production' &&
    result.data.GATEWAY_ENABLED &&
    !result.data.ALLOW_PLAINTEXT_GATEWAY_IN_PRODUCTION &&
    (result.data.BITCOIN_GATEWAY_TCP_ENABLED || result.data.MONERO_GATEWAY_TCP_ENABLED)
  ) {
    throw new Error(
      'Plaintext mining listeners are forbidden in production unless explicitly allowed',
    );
  }
  if (result.data.GATEWAY_ENABLED) {
    const listeners = [
      { name: 'HTTP API', host: result.data.HTTP_HOST, port: result.data.HTTP_PORT },
      ...(result.data.BITCOIN_GATEWAY_TCP_ENABLED
        ? [
            {
              name: 'Bitcoin TCP gateway',
              host: result.data.BITCOIN_GATEWAY_HOST,
              port: result.data.BITCOIN_GATEWAY_PORT,
            },
          ]
        : []),
      ...(result.data.BITCOIN_GATEWAY_TLS_ENABLED
        ? [
            {
              name: 'Bitcoin TLS gateway',
              host: result.data.BITCOIN_GATEWAY_TLS_HOST,
              port: result.data.BITCOIN_GATEWAY_TLS_PORT,
            },
          ]
        : []),
      ...(result.data.MONERO_GATEWAY_TCP_ENABLED
        ? [
            {
              name: 'Monero TCP gateway',
              host: result.data.MONERO_GATEWAY_HOST,
              port: result.data.MONERO_GATEWAY_PORT,
            },
          ]
        : []),
      ...(result.data.MONERO_GATEWAY_TLS_ENABLED
        ? [
            {
              name: 'Monero TLS gateway',
              host: result.data.MONERO_GATEWAY_TLS_HOST,
              port: result.data.MONERO_GATEWAY_TLS_PORT,
            },
          ]
        : []),
    ];
    const wildcardHosts = new Set(['0.0.0.0', '::', '[::]']);
    for (const [index, listener] of listeners.entries()) {
      for (const other of listeners.slice(index + 1)) {
        const hostsOverlap =
          listener.host === other.host ||
          wildcardHosts.has(listener.host) ||
          wildcardHosts.has(other.host);
        if (listener.port === other.port && hostsOverlap) {
          throw new Error(
            `${listener.name} and ${other.name} cannot bind overlapping addresses on port ${listener.port}`,
          );
        }
      }
    }
  }
  return result.data;
}

export function readSecretFile(path: string): string {
  const absolute = resolve(process.cwd(), path);
  try {
    const secret = readFileSync(absolute, 'utf8').trim();
    if (!secret) throw new Error('secret is empty');
    return secret;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`Unable to read secret file ${absolute}: ${reason}`);
  }
}
