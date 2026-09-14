import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../security/crypto.service';
import { jsonSafe } from '../common/json';

export interface AuditInput {
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  ipAddress?: string;
  before?: unknown;
  after?: unknown;
}

function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
}

@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4815162342)`;
      const previous = await tx.auditEvent.findFirst({
        orderBy: { sequence: 'desc' },
        select: { eventHash: true },
      });
      const createdAt = new Date();
      const before = input.before === undefined ? null : jsonSafe(input.before);
      const after = input.after === undefined ? null : jsonSafe(input.after);
      const payload = {
        actorId: input.actorId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        ipAddress: input.ipAddress ?? null,
        before,
        after,
        previousHash: previous?.eventHash ?? null,
        createdAt: createdAt.toISOString(),
      };
      await tx.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: input.action,
          entityType: input.entityType,
          entityId: input.entityId,
          ipAddress: input.ipAddress,
          before: before as Prisma.InputJsonValue,
          after: after as Prisma.InputJsonValue,
          previousHash: previous?.eventHash,
          eventHash: this.crypto.sha256(canonical(payload)),
          createdAt,
        },
      });
    });
  }

  list(limit = 100, cursor?: string) {
    return this.prisma.auditEvent.findMany({
      take: Math.min(Math.max(limit, 1), 500),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: { actor: { select: { id: true, email: true, displayName: true } } },
    });
  }

  async verify(): Promise<{ valid: boolean; checked: number; brokenEventId?: string }> {
    const events = await this.prisma.auditEvent.findMany({ orderBy: { sequence: 'asc' } });
    let previousHash: string | null = null;
    for (const event of events) {
      const payload = {
        actorId: event.actorId,
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        ipAddress: event.ipAddress,
        before: event.before,
        after: event.after,
        previousHash,
        createdAt: event.createdAt.toISOString(),
      };
      if (
        event.previousHash !== previousHash ||
        event.eventHash !== this.crypto.sha256(canonical(payload))
      ) {
        return { valid: false, checked: events.indexOf(event), brokenEventId: event.id };
      }
      previousHash = event.eventHash;
    }
    return { valid: true, checked: events.length };
  }
}
