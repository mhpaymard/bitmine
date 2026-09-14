import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../src/database/prisma.service';
import type { GatewayService } from '../../src/gateway/gateway.service';
import { HealthController } from '../../src/health/health.controller';
import type { RedisService } from '../../src/redis/redis.service';

function controller(gatewayStatus: { enabled: boolean; listeners: string[] }) {
  const prisma = { $queryRaw: vi.fn().mockResolvedValue([1]) } as unknown as PrismaService;
  const redis = {
    connect: vi.fn().mockResolvedValue(undefined),
    client: { ping: vi.fn().mockResolvedValue('PONG') },
  } as unknown as RedisService;
  const gateway = {
    status: vi.fn().mockReturnValue({ ...gatewayStatus, activeSockets: 0 }),
  } as unknown as GatewayService;
  return new HealthController(prisma, redis, gateway);
}

describe('health readiness', () => {
  it('is ready when dependencies and an enabled gateway listener are available', async () => {
    const result = await controller({
      enabled: true,
      listeners: ['Bitcoin TLS 0.0.0.0:443'],
    }).ready();

    expect(result).toMatchObject({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok', gateway: 'ok' },
    });
  });

  it('is degraded when the gateway is enabled but no listener was bound', async () => {
    const result = await controller({ enabled: true, listeners: [] }).ready();

    expect(result).toMatchObject({ status: 'degraded', checks: { gateway: 'failed' } });
  });

  it('allows an intentionally disabled gateway for maintenance/API-only operation', async () => {
    const result = await controller({ enabled: false, listeners: [] }).ready();

    expect(result).toMatchObject({ status: 'ok', checks: { gateway: 'disabled' } });
  });
});
