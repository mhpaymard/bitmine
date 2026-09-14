import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminRole } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AuditService } from './audit.service';

@Controller('api/v1/audit')
@UseGuards(AuthGuard, RolesGuard)
@Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get('verify')
  @Roles(AdminRole.OWNER)
  verify() {
    return this.audit.verify();
  }

  @Get()
  list(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.audit.list(limit ? Number(limit) : 100, cursor);
  }
}
