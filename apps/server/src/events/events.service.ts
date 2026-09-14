import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable, Subject, filter, map } from 'rxjs';

export interface DomainEvent<T = unknown> {
  type: string;
  data: T;
  at: string;
}

@Injectable()
export class EventsService {
  private readonly subject = new Subject<DomainEvent>();

  publish<T>(type: string, data: T): void {
    this.subject.next({ type, data, at: new Date().toISOString() });
  }

  stream(types?: string[]): Observable<MessageEvent> {
    return this.subject.pipe(
      filter((event) => !types?.length || types.includes(event.type)),
      map((event) => ({ type: event.type, data: event })),
    );
  }
}
