import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export enum ProxyProtocol {
  SOCKS5 = 'SOCKS5',
  HTTP = 'HTTP',
}

export enum ProxyMode {
  ALWAYS_ON = 'ALWAYS_ON',
  FAILOVER = 'FAILOVER',
}

export enum VpnConfigType {
  NONE = 'NONE',
  OPENVPN = 'OPENVPN',
  WIREGUARD = 'WIREGUARD',
}

export class UpdateProxySettingsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsEnum(ProxyMode)
  mode!: ProxyMode;

  @IsBoolean()
  applyToGateway!: boolean;

  @IsBoolean()
  applyToSystem!: boolean;

  @IsEnum(ProxyProtocol)
  protocol!: ProxyProtocol;

  @IsString()
  @MaxLength(255)
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  port!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  password?: string;

  @IsString()
  @MaxLength(255)
  healthCheckHost!: string;

  @IsInt()
  @Min(1)
  @Max(65_535)
  healthCheckPort!: number;

  @IsInt()
  @Min(5)
  @Max(600)
  healthCheckIntervalSeconds!: number;

  @IsInt()
  @Min(1)
  @Max(20)
  healthCheckFailureThreshold!: number;

  @IsEnum(VpnConfigType)
  vpnConfigType!: VpnConfigType;

  @IsOptional()
  @IsString()
  @MinLength(1)
  vpnConfig?: string;
}
