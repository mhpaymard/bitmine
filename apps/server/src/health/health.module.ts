import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';

@Module({ imports: [GatewayModule], controllers: [HealthController, MetricsController] })
export class HealthModule {}
