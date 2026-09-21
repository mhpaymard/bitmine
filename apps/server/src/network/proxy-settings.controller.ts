import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAdmin } from '../auth/auth.decorators';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateProxySettingsDto } from './proxy-settings.dto';
import { ProxyHealthService } from './proxy-health.service';
import { ProxySettingsService } from './proxy-settings.service';

@Controller('api/v1/network/proxy')
@UseGuards(AuthGuard, RolesGuard)
export class ProxySettingsController {
  constructor(
    private readonly settings: ProxySettingsService,
    private readonly health: ProxyHealthService,
  ) {}

  @Get()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
  async get() {
    const settings = await this.settings.safe();
    return { settings, status: this.health.status() };
  }

  @Put()
  @Roles(AdminRole.OWNER)
  update(@Body() body: UpdateProxySettingsDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.settings.update(body, admin);
  }
}
