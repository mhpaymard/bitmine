import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminRole, AssetCode } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { StatsService } from './stats.service';

@Controller('api/v1/stats')
@UseGuards(AuthGuard, RolesGuard)
@Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get('dashboard')
  dashboard() {
    return this.stats.dashboard();
  }

  @Get('workers')
  workers(@Query('asset') asset?: AssetCode) {
    return this.stats.workers(asset);
  }
}
