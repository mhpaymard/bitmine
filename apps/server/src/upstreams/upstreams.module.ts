import { Module } from '@nestjs/common';
import { NetworkModule } from '../network/network.module';
import { WalletsModule } from '../wallets/wallets.module';
import { UpstreamsController } from './upstreams.controller';
import { UpstreamsService } from './upstreams.service';

@Module({
  imports: [WalletsModule, NetworkModule],
  controllers: [UpstreamsController],
  providers: [UpstreamsService],
  exports: [UpstreamsService],
})
export class UpstreamsModule {}
