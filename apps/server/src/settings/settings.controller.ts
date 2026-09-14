import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAdmin } from '../auth/auth.decorators';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateOperatorPayoutDto, UpdatePayoutScheduleDto } from './settings.dto';
import { SettingsService } from './settings.service';

@Controller('api/v1/settings')
@UseGuards(AuthGuard, RolesGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
  list() {
    return this.settings.list();
  }

  @Put('payout-schedule')
  @Roles(AdminRole.OWNER)
  updateSchedule(@Body() body: UpdatePayoutScheduleDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.settings.updatePayoutSchedule(body, admin);
  }

  @Put('operator-payout')
  @Roles(AdminRole.OWNER)
  updateOperatorPayout(
    @Body() body: UpdateOperatorPayoutDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.settings.updateOperatorPayout(body, admin);
  }
}
