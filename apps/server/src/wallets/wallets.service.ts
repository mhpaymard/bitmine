import { BadRequestException, Injectable } from '@nestjs/common';
import { AssetCode } from '@prisma/client';
import { BitcoinWalletAdapter } from './bitcoin-wallet.adapter';
import { MoneroWalletAdapter } from './monero-wallet.adapter';
import type { WalletAdapter } from './wallet-adapter';

@Injectable()
export class WalletsService {
  constructor(
    private readonly bitcoin: BitcoinWalletAdapter,
    private readonly monero: MoneroWalletAdapter,
  ) {}

  forAsset(asset: AssetCode): WalletAdapter {
    if (asset === AssetCode.BTC) return this.bitcoin;
    if (asset === AssetCode.XMR) return this.monero;
    throw new BadRequestException(`Unsupported wallet asset ${String(asset)}`);
  }

  async statuses() {
    const result = await Promise.allSettled([
      this.bitcoin.status().then((status) => ({ asset: AssetCode.BTC, ok: true, status })),
      this.monero.status().then((status) => ({ asset: AssetCode.XMR, ok: true, status })),
    ]);
    return result.map((entry, index) =>
      entry.status === 'fulfilled'
        ? entry.value
        : {
            asset: index === 0 ? AssetCode.BTC : AssetCode.XMR,
            ok: false,
            error: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
          },
    );
  }
}
