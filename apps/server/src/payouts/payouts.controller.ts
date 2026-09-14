import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole, AssetCode } from '@prisma/client';
import { IsEnum, IsString, Length } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAdmin } from '../auth/auth.decorators';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { PayoutsService } from './payouts.service';

class PlanPayoutDto {
  @IsEnum(AssetCode) asset!: AssetCode;
}
class ApprovePayoutDto {
  @IsString() @Length(6, 6) totpCode!: string;
}

@Controller('api/v1/payouts')
@UseGuards(AuthGuard, RolesGuard)
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  @Get()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
  list(@Query('asset') asset?: AssetCode) {
    return this.payouts.list(asset);
  }

  @Post('plan')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  plan(@Body() body: PlanPayoutDto) {
    return this.payouts.plan(body.asset);
  }

  @Post('operator/plan')
  @Roles(AdminRole.OWNER)
  planOperator(@Body() body: PlanPayoutDto) {
    return this.payouts.planOperator(body.asset);
  }

  @Post(':id/approve')
  @Roles(AdminRole.OWNER)
  approve(
    @Param('id') id: string,
    @Body() body: ApprovePayoutDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.payouts.approve(id, admin, body.totpCode);
  }

  @Post(':id/execute')
  @Roles(AdminRole.OWNER)
  execute(@Param('id') id: string) {
    return this.payouts.execute(id);
  }

  @Post('reconcile')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  async reconcile() {
    await this.payouts.reconcile();
    return { ok: true };
  }
}
