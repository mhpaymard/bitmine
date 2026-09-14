import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AlertsService } from './alerts.service';

@Controller('api/v1/alerts')
@UseGuards(AuthGuard, RolesGuard)
@Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @Get()
  list() {
    return this.alerts.list();
  }

  @Post(':id/resolve')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  resolve(@Param('id') id: string) {
    return this.alerts.resolve(id);
  }
}
