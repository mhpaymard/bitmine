import { Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PortalAccessDto, PortalDestinationDto } from './public-portal.dto';
import { PublicPortalService } from './public-portal.service';

@Controller('api/v1/public/portal')
export class PublicPortalController {
  constructor(private readonly portal: PublicPortalService) {}

  @Post('summary')
  summary(@Body() body: PortalAccessDto, @Req() request: FastifyRequest) {
    return this.portal.summary(body, request.ip);
  }

  @Post('payout-destinations')
  destination(@Body() body: PortalDestinationDto, @Req() request: FastifyRequest) {
    return this.portal.requestDestination(body, request.ip);
  }
}
