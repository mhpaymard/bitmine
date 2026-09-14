import { AssetCode } from '@prisma/client';
import {
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

export enum OperatorPayoutMode {
  RETAIN = 'RETAIN',
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  MANUAL = 'MANUAL',
}

export class UpdatePayoutScheduleDto {
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/u)
  time!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timezone!: string;
}

export class UpdateOperatorPayoutDto {
  @IsEnum(AssetCode)
  asset!: AssetCode;

  @IsEnum(OperatorPayoutMode)
  mode!: OperatorPayoutMode;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  address?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/u)
  minPayoutAtomic?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  weekday?: number;
}
