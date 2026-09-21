import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { ConfigService } from '@nestjs/config';
import { AssetCode } from '@prisma/client';
import type { AuditService } from '../audit/audit.service';
import { validateEnvironment, type Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { ProxyHealthService } from '../network/proxy-health.service';
import { ProxySettingsService } from '../network/proxy-settings.service';
import { CryptoService } from '../security/crypto.service';
import { UpstreamsService } from '../upstreams/upstreams.service';
import { BitcoinWalletAdapter } from '../wallets/bitcoin-wallet.adapter';
import { MoneroWalletAdapter } from '../wallets/monero-wallet.adapter';
import { WalletsService } from '../wallets/wallets.service';

for (const environmentFile of [
  resolve(process.cwd(), '../../.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(environmentFile)) loadEnvFile(environmentFile);
}

async function main(): Promise<void> {
  const environment = validateEnvironment({ ...process.env, NODE_ENV: 'production' });
  const config = new ConfigService<Environment, true>(environment);
  const prisma = new PrismaService(config);
  try {
    const crypto = new CryptoService(config);
    const wallets = new WalletsService(
      new BitcoinWalletAdapter(config),
      new MoneroWalletAdapter(config),
    );
    const proxySettings = new ProxySettingsService(prisma, crypto, {} as AuditService);
    const proxyHealth = new ProxyHealthService(proxySettings);
    const upstreams = new UpstreamsService(
      prisma,
      crypto,
      {} as AuditService,
      wallets,
      proxyHealth,
    );
    const walletStatuses = await wallets.statuses();
    const walletFailures = walletStatuses.filter((status) => !status.ok);
    if (walletFailures.length) {
      throw new Error(
        `Wallet checks failed: ${walletFailures
          .map(
            (status) => `${status.asset}: ${String('error' in status ? status.error : 'unknown')}`,
          )
          .join('; ')}`,
      );
    }

    const records = await prisma.upstream.findMany({ where: { enabled: true } });
    for (const asset of [AssetCode.BTC, AssetCode.XMR]) {
      if (!records.some((record) => record.asset === asset))
        throw new Error(`No enabled ${asset} upstream is configured`);
    }
    const accounts = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const key = `${record.asset}:${record.accountKey}`;
      const peer = accounts.get(key);
      if (!record.receiveAddress) throw new Error(`${record.name} has no receive address`);
      if (peer && peer.receiveAddress !== record.receiveAddress)
        throw new Error(`${record.name} disagrees with its pool account receive address`);
      accounts.set(key, record);
    }
    for (const account of accounts.values()) {
      const valid = await wallets.forAsset(account.asset).validateAddress(account.receiveAddress!);
      if (!valid) throw new Error(`${account.name} has an invalid receive address`);
    }
    for (const record of records) {
      const result = await upstreams.test(record.id);
      if (!result.ok) throw new Error(`${record.name}: ${result.message}`);
    }

    process.stdout.write(
      `Operational self-test passed: ${walletStatuses.length} wallets, ${accounts.size} pool accounts, ${records.length} endpoints.\n`,
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
