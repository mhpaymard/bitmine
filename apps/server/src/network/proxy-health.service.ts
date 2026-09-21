import { connect } from 'node:net';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ProxyMode } from './proxy-settings.dto';
import type { ResolvedGatewayProxy } from './proxy-settings.service';
import { ProxySettingsService } from './proxy-settings.service';

/**
 * Tracks whether the server's direct (non-proxied) internet path is reachable, and resolves
 * the proxy config that gateway upstream connections should dial through right now. Runs a
 * lightweight TCP probe on a fixed schedule; only does anything when a proxy is enabled.
 */
@Injectable()
export class ProxyHealthService {
  private readonly logger = new Logger(ProxyHealthService.name);
  private directUp = true;
  private consecutiveFailures = 0;
  private lastCheckedAt: Date | null = null;

  constructor(private readonly settings: ProxySettingsService) {}

  status() {
    return {
      directUp: this.directUp,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckedAt: this.lastCheckedAt?.toISOString() ?? null,
    };
  }

  async resolveGatewayProxy(): Promise<ResolvedGatewayProxy | null> {
    const setting = await this.settings.get();
    if (!setting.enabled || !setting.applyToGateway || !setting.host) return null;
    if (setting.mode === ProxyMode.FAILOVER && this.directUp) return null;
    return {
      protocol: setting.protocol,
      host: setting.host,
      port: setting.port,
      username: setting.username ?? undefined,
      password: this.settings.decryptPassword(setting),
    };
  }

  @Cron('*/10 * * * * *')
  async tick(): Promise<void> {
    const setting = await this.settings.get();
    if (!setting.enabled) {
      this.directUp = true;
      this.consecutiveFailures = 0;
      return;
    }
    if (setting.mode === ProxyMode.ALWAYS_ON) {
      this.settings.writeState(setting, 'PROXY');
      return;
    }
    const elapsedOk =
      !this.lastCheckedAt ||
      Date.now() - this.lastCheckedAt.getTime() >= setting.healthCheckIntervalSeconds * 1000;
    if (!elapsedOk) return;
    this.lastCheckedAt = new Date();
    const reachable = await this.probe(setting.healthCheckHost, setting.healthCheckPort);
    if (reachable) {
      if (!this.directUp) this.logger.log('Direct internet path recovered; leaving proxy failover');
      this.directUp = true;
      this.consecutiveFailures = 0;
    } else {
      this.consecutiveFailures += 1;
      if (this.directUp && this.consecutiveFailures >= setting.healthCheckFailureThreshold) {
        this.logger.warn(
          `Direct internet path failed ${this.consecutiveFailures} consecutive checks; failing over to proxy`,
        );
        this.directUp = false;
      }
    }
    this.settings.writeState(setting, this.directUp ? 'DIRECT' : 'PROXY');
  }

  private probe(host: string, port: number): Promise<boolean> {
    return new Promise((resolveProbe) => {
      const socket = connect({ host, port, timeout: 5_000 });
      const finish = (result: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolveProbe(result);
      };
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }
}
