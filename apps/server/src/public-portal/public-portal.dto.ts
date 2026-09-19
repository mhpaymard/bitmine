import { AssetCode } from '@prisma/client';
import { IsEnum, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class PortalAccessDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/u)
  customerSlug!: string;

  @IsString()
  @MinLength(20)
  @MaxLength(200)
  accessCode!: string;
}

export class PortalDestinationDto extends PortalAccessDto {
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
