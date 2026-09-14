import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../database/prisma.service';
import { GatewayService } from '../gateway/gateway.service';
import { RedisService } from '../redis/redis.service';

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly gateway: GatewayService,
  ) {}

  @Get('live')
  @Public()
  live() {
    return { status: 'ok', at: new Date().toISOString() };
  }

  @Get('ready')
  @Public()
  async ready() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      checks.postgres = 'failed';
    }
    try {
      await this.redis.connect();
      checks.redis = (await this.redis.client.ping()) === 'PONG' ? 'ok' : 'failed';
    } catch {
      checks.redis = 'failed';
    }
    const gateway = this.gateway.status();
    checks.gateway = !gateway.enabled ? 'disabled' : gateway.listeners.length > 0 ? 'ok' : 'failed';
    const ready = Object.values(checks).every((value) => value === 'ok' || value === 'disabled');
    return {
      status: ready ? 'ok' : 'degraded',
      checks,
      gateway,
      at: new Date().toISOString(),
    };
  }
}
