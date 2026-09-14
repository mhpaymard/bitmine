import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole, AssetCode } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAdmin } from '../auth/auth.decorators';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CreateUpstreamDto, UpdateUpstreamDto } from './dto/upstreams.dto';
import { UpstreamsService } from './upstreams.service';

@Controller('api/v1/upstreams')
@UseGuards(AuthGuard, RolesGuard)
export class UpstreamsController {
  constructor(private readonly upstreams: UpstreamsService) {}

  @Get()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
  list(@Query('asset') asset?: AssetCode) {
    return this.upstreams.list(asset);
  }

  @Post()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  create(@Body() body: CreateUpstreamDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.upstreams.create(body, admin);
  }

  @Patch(':id')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  update(
    @Param('id') id: string,
    @Body() body: UpdateUpstreamDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.upstreams.update(id, body, admin);
  }

  @Post(':id/test')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  test(@Param('id') id: string) {
    return this.upstreams.test(id);
  }
}
