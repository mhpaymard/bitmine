import { Controller, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AuthGuard } from '../auth/auth.guard';
import { EventsService } from './events.service';

@Controller('api/v1/events')
@UseGuards(AuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse()
  stream(@Query('types') types?: string): Observable<MessageEvent> {
    return this.events.stream(types?.split(',').filter(Boolean));
  }
}
