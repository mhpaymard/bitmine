import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import {
  ProxyMode,
  ProxyProtocol,
  UpdateProxySettingsDto,
  VpnConfigType,
} from './proxy-settings.dto';

const SETTING_KEY = 'network.proxy';
const PASSWORD_CONTEXT = 'network-proxy:password';
const VPN_CONFIG_CONTEXT = 'network-proxy:vpn-config';

export const NETPROXY_STATE_DIR = resolve(process.cwd(), '../../.local/netproxy');
const STATE_FILE = resolve(NETPROXY_STATE_DIR, 'state.json');
const VPN_CONFIG_FILE = resolve(NETPROXY_STATE_DIR, 'vpn-config.conf');

export interface ProxySetting {
  enabled: boolean;
  mode: ProxyMode;
  applyToGateway: boolean;
  applyToSystem: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  passwordCiphertext: string | null;
  healthCheckHost: string;
  healthCheckPort: number;
  healthCheckIntervalSeconds: number;
  healthCheckFailureThreshold: number;
  vpnConfigType: VpnConfigType;
  vpnConfigCiphertext: string | null;
}

export interface ResolvedGatewayProxy {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const DEFAULT_SETTING: ProxySetting = {
  enabled: false,
  mode: ProxyMode.FAILOVER,
  applyToGateway: true,
  applyToSystem: false,
  protocol: ProxyProtocol.SOCKS5,
  host: '',
  port: 1080,
  username: null,
  passwordCiphertext: null,
  healthCheckHost: '1.1.1.1',
  healthCheckPort: 443,
  healthCheckIntervalSeconds: 30,
  healthCheckFailureThreshold: 3,
  vpnConfigType: VpnConfigType.NONE,
  vpnConfigCiphertext: null,
};

@Injectable()
export class ProxySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<ProxySetting> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: SETTING_KEY } });
    return row ? { ...DEFAULT_SETTING, ...(row.value as Partial<ProxySetting>) } : DEFAULT_SETTING;
  }

  async safe(): Promise<
    Omit<ProxySetting, 'passwordCiphertext' | 'vpnConfigCiphertext'> & {
      hasPassword: boolean;
      hasVpnConfig: boolean;
    }
  > {
    const setting = await this.get();
    const { passwordCiphertext, vpnConfigCiphertext, ...rest } = setting;
    return {
      ...rest,
      hasPassword: Boolean(passwordCiphertext),
      hasVpnConfig: Boolean(vpnConfigCiphertext),
    };
  }

  async update(dto: UpdateProxySettingsDto, actor: AuthenticatedAdmin) {
    if (dto.applyToGateway && !dto.host.trim()) {
      throw new BadRequestException('A proxy host is required when applying to the gateway');
    }
    if (dto.applyToSystem && dto.vpnConfigType === VpnConfigType.NONE) {
      throw new BadRequestException(
        'System-wide proxying requires an OpenVPN or WireGuard configuration',
      );
    }
    const before = await this.get();
    if (
      dto.applyToSystem &&
      dto.vpnConfigType !== VpnConfigType.NONE &&
      !dto.vpnConfig?.trim() &&
      (before.vpnConfigType !== dto.vpnConfigType || !before.vpnConfigCiphertext)
    ) {
      throw new BadRequestException('Upload a VPN configuration before enabling this mode');
    }
    const value: ProxySetting = {
      enabled: dto.enabled,
      mode: dto.mode,
      applyToGateway: dto.applyToGateway,
      applyToSystem: dto.applyToSystem,
      protocol: dto.protocol,
      host: dto.host.trim(),
      port: dto.port,
      username: dto.username?.trim() || null,
      passwordCiphertext:
        dto.password === undefined
          ? before.passwordCiphertext
          : dto.password
            ? this.crypto.encrypt(dto.password, PASSWORD_CONTEXT)
            : null,
      healthCheckHost: dto.healthCheckHost.trim(),
      healthCheckPort: dto.healthCheckPort,
      healthCheckIntervalSeconds: dto.healthCheckIntervalSeconds,
      healthCheckFailureThreshold: dto.healthCheckFailureThreshold,
      vpnConfigType: dto.vpnConfigType,
      vpnConfigCiphertext:
        dto.vpnConfig === undefined
          ? before.vpnConfigType === dto.vpnConfigType
            ? before.vpnConfigCiphertext
            : null
          : this.crypto.encrypt(dto.vpnConfig, VPN_CONFIG_CONTEXT),
    };
    const jsonValue = value as unknown as Prisma.InputJsonValue;
    await this.prisma.systemSetting.upsert({
      where: { key: SETTING_KEY },
      create: { key: SETTING_KEY, value: jsonValue },
      update: { value: jsonValue },
    });
    await this.audit.record({
      actorId: actor.id,
      action: 'NETWORK_PROXY_UPDATED',
      entityType: 'SystemSetting',
      entityId: SETTING_KEY,
      before: this.redact(before),
      after: this.redact(value),
    });
    this.writeState(value, null);
    return this.safe();
  }

  private redact(value: ProxySetting) {
    return {
      ...value,
      passwordCiphertext: value.passwordCiphertext ? '[redacted]' : null,
      vpnConfigCiphertext: value.vpnConfigCiphertext ? '[redacted]' : null,
    };
  }

  decryptPassword(setting: ProxySetting): string | undefined {
    return setting.passwordCiphertext
      ? this.crypto.decrypt(setting.passwordCiphertext, PASSWORD_CONTEXT)
      : undefined;
  }

  /**
   * Writes the resolved decision to disk for the privileged mining-gateway-netproxy.service
   * helper (running as root, outside this process's hardened sandbox) to apply OS-level
   * routing. This process never touches network interfaces or routing tables itself.
   */
  writeState(setting: ProxySetting, activeMode: 'DIRECT' | 'PROXY' | null): void {
    mkdirSync(NETPROXY_STATE_DIR, { recursive: true, mode: 0o700 });
    const useProxy =
      activeMode === 'PROXY' || (activeMode === null && setting.mode === ProxyMode.ALWAYS_ON);
    const state = {
      applyToSystem: setting.applyToSystem && setting.enabled,
      active: setting.applyToSystem && setting.enabled && useProxy,
      vpnConfigType: setting.vpnConfigType,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
    if (setting.vpnConfigCiphertext && setting.vpnConfigType !== VpnConfigType.NONE) {
      const plaintext = this.crypto.decrypt(setting.vpnConfigCiphertext, VPN_CONFIG_CONTEXT);
      writeFileSync(VPN_CONFIG_FILE, plaintext, { mode: 0o600 });
    }
  }
}
