import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminRole, AssetCode } from '@prisma/client';
import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { DepositsService } from './deposits.service';
import { WalletsService } from './wallets.service';

class ValidateAddressDto {
  @IsEnum(AssetCode) asset!: AssetCode;
  @IsString() @MinLength(10) @MaxLength(256) address!: string;
}

class CreateReceiveAddressDto {
  @IsEnum(AssetCode) asset!: AssetCode;
  @IsString() @MinLength(1) @MaxLength(120) label!: string;
}

@Controller('api/v1/wallets')
@UseGuards(AuthGuard, RolesGuard)
@Roles(AdminRole.OWNER, AdminRole.OPERATOR, AdminRole.VIEWER)
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly deposits: DepositsService,
  ) {}

  @Get('status')
  status() {
    return this.wallets.statuses();
  }

  @Post('validate-address')
  async validate(@Body() body: ValidateAddressDto) {
    return { valid: await this.wallets.forAsset(body.asset).validateAddress(body.address) };
  }

  @Post('receive-address')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  async createReceiveAddress(@Body() body: CreateReceiveAddressDto) {
    return { address: await this.wallets.forAsset(body.asset).createReceiveAddress(body.label) };
  }

  @Post('scan')
  @Roles(AdminRole.OWNER, AdminRole.OPERATOR)
  async scan() {
    await this.deposits.scanAll();
    return { ok: true };
  }

  @Get('deposits')
  depositsList(@Query('asset') asset?: AssetCode) {
    return this.deposits.list(asset);
  }
}
