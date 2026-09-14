import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { AdminRole, EntityStatus } from '@prisma/client';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentAdmin } from '../auth/auth.decorators';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  CreatePayoutDestinationDto,
  CreateSplitPolicyDto,
  CreateWorkerDto,
  RotateCredentialDto,
  UpdateCustomerDto,
} from './dto/customers.dto';

@Controller('api/v1/customers')
@UseGuards(AuthGuard, RolesGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
  list() {
    return this.customers.list();
  }

  @Get(':id')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Post()
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  create(@Body() body: CreateCustomerDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.customers.create(body, admin);
  }

  @Patch(':id')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  update(
    @Param('id') id: string,
    @Body() body: UpdateCustomerDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.customers.update(id, body, admin);
  }

  @Post(':id/disable')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  disable(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.customers.setStatus(id, EntityStatus.DISABLED, admin);
  }

  @Post(':id/enable')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  enable(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.customers.setStatus(id, EntityStatus.ACTIVE, admin);
  }

  @Post(':id/workers')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  createWorker(
    @Param('id') id: string,
    @Body() body: CreateWorkerDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.customers.createWorker(id, body, admin);
  }

  @Post('workers/:workerId/credentials/rotate')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  rotate(
    @Param('workerId') id: string,
    @Body() body: RotateCredentialDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.customers.rotateCredential(id, body, admin);
  }

  @Post('credentials/:credentialId/revoke')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  revoke(@Param('credentialId') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.customers.revokeCredential(id, admin);
  }

  @Post(':id/split-policies')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  policy(
    @Param('id') id: string,
    @Body() body: CreateSplitPolicyDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.customers.createPolicy(id, body, admin);
  }

  @Post(':id/payout-destinations')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  destination(
    @Param('id') id: string,
    @Body() body: CreatePayoutDestinationDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.customers.createDestination(id, body, admin);
  }
}
