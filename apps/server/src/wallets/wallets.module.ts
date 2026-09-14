import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { BitcoinWalletAdapter } from './bitcoin-wallet.adapter';
import { DepositsService } from './deposits.service';
import { MoneroWalletAdapter } from './monero-wallet.adapter';
import { WalletsController } from './wallets.controller';
import { WalletsService } from './wallets.service';

@Module({
  imports: [LedgerModule],
  controllers: [WalletsController],
  providers: [BitcoinWalletAdapter, MoneroWalletAdapter, WalletsService, DepositsService],
  exports: [WalletsService, DepositsService],
})
export class WalletsModule {}
