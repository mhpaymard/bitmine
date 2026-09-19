import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole, AssetCode } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { LedgerService } from './ledger.service';

@Controller('api/v1/ledger')
@UseGuards(AuthGuard, RolesGuard)
@Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get('transactions')
  transactions(@Query('asset') asset?: AssetCode, @Query('limit') limit?: string) {
    return this.ledger.listTransactions(asset, limit ? Number(limit) : 100);
  }

  @Get('customer-balances')
  customerBalances(@Query('asset') asset?: AssetCode) {
    return this.ledger.customerBalances(asset);
  }

  @Get('trial-balance/:asset')
  trialBalance(@Param('asset') asset: AssetCode) {
    return this.ledger.trialBalance(asset);
  }

  @Post('allocate/:depositId')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  allocate(@Param('depositId') depositId: string) {
    return this.ledger.allocateDeposit(depositId);
  }
}
