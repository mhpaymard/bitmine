import { AssetCode, PoolProtocol } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
} from 'class-validator';

export class CreateUpstreamDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$/u)
  accountKey?: string;

  @IsEnum(AssetCode)
  asset!: AssetCode;

  @IsEnum(PoolProtocol)
  protocol!: PoolProtocol;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  host!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsBoolean()
  tls!: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  priority!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  usernameTemplate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  receiveAddress?: string;
}

export class UpdateUpstreamDto {
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{1,118}[a-z0-9]$/u)
  accountKey?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(255) host?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) port?: number;
  @IsOptional() @IsBoolean() tls?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) priority?: number;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(255) usernameTemplate?: string;
  @IsOptional() @IsString() @MaxLength(500) password?: string;
  @IsOptional() @IsString() @MaxLength(256) receiveAddress?: string;
}
