import { createServer, type AddressInfo, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProxyHealthService } from '../../src/network/proxy-health.service';
import { ProxyMode, ProxyProtocol, VpnConfigType } from '../../src/network/proxy-settings.dto';
import type { ProxySettingsService } from '../../src/network/proxy-settings.service';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))));
});

async function listeningServer(): Promise<{ host: string; port: number }> {
  const server = createServer((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { host: address.address, port: address.port };
}

function fakeSettings(overrides: Record<string, unknown>) {
  const value = {
    enabled: true,
    mode: ProxyMode.FAILOVER,
    applyToGateway: true,
    applyToSystem: false,
    protocol: ProxyProtocol.SOCKS5,
    host: 'proxy.example.com',
    port: 1080,
    username: null,
    passwordCiphertext: null,
    healthCheckHost: '127.0.0.1',
    healthCheckPort: 1,
    healthCheckIntervalSeconds: 5,
    healthCheckFailureThreshold: 2,
    vpnConfigType: VpnConfigType.NONE,
    vpnConfigCiphertext: null,
    ...overrides,
  };
  return {
    get: vi.fn().mockResolvedValue(value),
    decryptPassword: vi.fn().mockReturnValue(undefined),
    writeState: vi.fn(),
  } as unknown as ProxySettingsService;
}

describe('ProxyHealthService', () => {
  it('returns no proxy when disabled', async () => {
    const health = new ProxyHealthService(fakeSettings({ enabled: false }));
    await expect(health.resolveGatewayProxy()).resolves.toBeNull();
  });

  it('returns no proxy when not applied to the gateway', async () => {
    const health = new ProxyHealthService(fakeSettings({ applyToGateway: false }));
    await expect(health.resolveGatewayProxy()).resolves.toBeNull();
  });

  it('always resolves the proxy in ALWAYS_ON mode', async () => {
    const health = new ProxyHealthService(fakeSettings({ mode: ProxyMode.ALWAYS_ON }));
    const resolved = await health.resolveGatewayProxy();
    expect(resolved?.host).toBe('proxy.example.com');
  });

  it('prefers the direct path in FAILOVER mode until the health probe fails enough times', async () => {
    const settings = fakeSettings({
      healthCheckPort: 1, // nothing listens on port 1; probe should fail fast
      healthCheckIntervalSeconds: 0,
      healthCheckFailureThreshold: 2,
    });
    const health = new ProxyHealthService(settings);
    await expect(health.resolveGatewayProxy()).resolves.toBeNull();

    await health.tick();
    await expect(health.resolveGatewayProxy()).resolves.toBeNull();

    await health.tick();
    const resolved = await health.resolveGatewayProxy();
    expect(resolved?.host).toBe('proxy.example.com');
  }, 15_000);

  it('recovers to the direct path as soon as one probe succeeds', async () => {
    const target = await listeningServer();
    const settings = fakeSettings({
      healthCheckHost: target.host,
      healthCheckPort: target.port,
      healthCheckIntervalSeconds: 5,
      healthCheckFailureThreshold: 1,
    });
    const health = new ProxyHealthService(settings);
    await health.tick();
    await expect(health.resolveGatewayProxy()).resolves.toBeNull();
  });
});
