import { Module } from '@nestjs/common';
import { UpstreamsModule } from '../upstreams/upstreams.module';
import { GatewayAuthService } from './gateway-auth.service';
import { GatewayService } from './gateway.service';
import { ShareJournalService } from './share-journal.service';
import { ShareMaintenanceService } from './share-maintenance.service';
import { UpstreamRuntimeService } from './upstream-runtime.service';

@Module({
  imports: [UpstreamsModule],
  providers: [
    GatewayAuthService,
    ShareJournalService,
    ShareMaintenanceService,
    UpstreamRuntimeService,
    GatewayService,
  ],
  exports: [GatewayService, ShareJournalService],
})
export class GatewayModule {}
