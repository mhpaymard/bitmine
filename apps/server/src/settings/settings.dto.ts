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

export enum PayoutScheduleMode {
  DAILY = 'DAILY',
  INTERVAL = 'INTERVAL',
}

export enum NetworkFeePayer {
  CUSTOMER = 'CUSTOMER',
  OPERATOR = 'OPERATOR',
}

export class UpdatePayoutScheduleDto {
  @IsEnum(PayoutScheduleMode)
  mode!: PayoutScheduleMode;

  @IsInt()
  @Min(60)
  @Max(10_080)
  intervalMinutes!: number;

  @IsInt()
  @Min(0)
  @Max(59)
  minuteOffset!: number;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/u)
  dailyTime!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  timezone!: string;

  @IsEnum(NetworkFeePayer)
  feePayer!: NetworkFeePayer;

  @IsInt()
  @Min(1)
  @Max(10_000)
  maxFeeBps!: number;

  @IsInt()
  @Min(1)
  @Max(1_000)
  maxBatchItems!: number;

  @IsString()
  @Matches(/^\d+$/u)
  bitcoinMinimumAtomic!: string;

  @IsString()
  @Matches(/^\d+$/u)
  moneroMinimumAtomic!: string;

  @IsString()
  @Matches(/^\d+$/u)
  bitcoinDailyAutoLimitAtomic!: string;

  @IsString()
  @Matches(/^\d+$/u)
  moneroDailyAutoLimitAtomic!: string;
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
