import { AssetCode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateCustomerDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/u)
  slug!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class UpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notes?: string;
}

export class CreateWorkerDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u)
  slug!: string;

  @IsEnum(AssetCode)
  asset!: AssetCode;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxConnections?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  allowedIps?: string[];
}

export class RotateCredentialDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1440)
  graceMinutes?: number;
}

export class CreateSplitPolicyDto {
  @IsEnum(AssetCode)
  asset!: AssetCode;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10000)
  customerBps!: number;

  @IsOptional()
  @IsDateString()
  effectiveAt?: string;
}

export class CreatePayoutDestinationDto {
  @IsEnum(AssetCode)
  asset!: AssetCode;

  @IsString()
  @MinLength(10)
  @MaxLength(256)
  address!: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/u)
  minPayoutAtomic?: string;
}
