import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module';
import { UpstreamsController } from './upstreams.controller';
import { UpstreamsService } from './upstreams.service';

@Module({
  imports: [WalletsModule],
  controllers: [UpstreamsController],
  providers: [UpstreamsService],
  exports: [UpstreamsService],
})
export class UpstreamsModule {}
