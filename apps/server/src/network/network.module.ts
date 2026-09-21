import { Module } from '@nestjs/common';
import { ProxyHealthService } from './proxy-health.service';
import { ProxySettingsController } from './proxy-settings.controller';
import { ProxySettingsService } from './proxy-settings.service';

@Module({
  controllers: [ProxySettingsController],
  providers: [ProxySettingsService, ProxyHealthService],
  exports: [ProxySettingsService, ProxyHealthService],
})
export class NetworkModule {}
