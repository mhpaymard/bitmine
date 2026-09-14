import { Controller, Get, Header } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../database/prisma.service';

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'mining_gateway_' });
const activeWorkers = new Gauge({
  name: 'mining_gateway_active_worker_connections',
  help: 'Active downstream worker connections',
  registers: [registry],
});
const openAlerts = new Gauge({
  name: 'mining_gateway_open_alerts',
  help: 'Open operational alerts',
  registers: [registry],
});
export const resolvedShares = new Counter({
  name: 'mining_gateway_resolved_shares_total',
  help: 'Shares resolved by the gateway process',
  labelNames: ['asset', 'status'],
  registers: [registry],
});

@Controller('metrics')
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Public()
  @Header('content-type', registry.contentType)
  async metrics(): Promise<string> {
    const [connections, alerts] = await Promise.all([
      this.prisma.connectionSession.count({ where: { disconnectedAt: null } }),
      this.prisma.alert.count({ where: { status: 'OPEN' } }),
    ]);
    activeWorkers.set(connections);
    openAlerts.set(alerts);
    return registry.metrics();
  }
}
