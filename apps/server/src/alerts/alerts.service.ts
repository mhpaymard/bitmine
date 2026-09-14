import { Injectable } from '@nestjs/common';
import { AlertSeverity, AlertStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { EventsService } from '../events/events.service';

@Injectable()
export class AlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsService,
  ) {}

  async raise(input: {
    dedupeKey: string;
    severity: AlertSeverity;
    title: string;
    message: string;
    metadata?: Prisma.InputJsonValue;
  }) {
    const existing = await this.prisma.alert.findFirst({
      where: { dedupeKey: input.dedupeKey, status: AlertStatus.OPEN },
    });
    const alert = existing
      ? await this.prisma.alert.update({
          where: { id: existing.id },
          data: { ...input, lastSeenAt: new Date() },
        })
      : await this.prisma.alert.create({ data: input });
    this.events.publish('alert.open', alert);
    return alert;
  }

  list() {
    return this.prisma.alert.findMany({
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
      take: 500,
    });
  }

  resolve(id: string) {
    return this.prisma.alert.update({
      where: { id },
      data: { status: AlertStatus.RESOLVED, resolvedAt: new Date() },
    });
  }

  async resolveByDedupe(dedupeKey: string): Promise<void> {
    const result = await this.prisma.alert.updateMany({
      where: { dedupeKey, status: AlertStatus.OPEN },
      data: { status: AlertStatus.RESOLVED, resolvedAt: new Date() },
    });
    if (result.count > 0) this.events.publish('alert.resolved', { dedupeKey });
  }
}
