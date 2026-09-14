import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../src/audit/audit.service';
import type { PrismaService } from '../../src/database/prisma.service';
import type { CryptoService } from '../../src/security/crypto.service';

describe('tamper-evident audit chain', () => {
  it('chains canonical event hashes and identifies the first modified event', async () => {
    const events: Array<Record<string, unknown>> = [];
    interface AuditCreateInput {
      data: {
        actorId?: string;
        action: string;
        entityType: string;
        entityId?: string;
        ipAddress?: string;
        before?: unknown;
        after?: unknown;
        previousHash?: string;
        eventHash: string;
        createdAt: Date;
      };
    }
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      auditEvent: {
        findFirst: vi
          .fn()
          .mockImplementation(() =>
            Promise.resolve(events.length ? { eventHash: events.at(-1)?.eventHash } : null),
          ),
        create: vi.fn().mockImplementation(({ data }: AuditCreateInput) => {
          const event = {
            id: `event-${events.length + 1}`,
            sequence: BigInt(events.length + 1),
            actorId: data.actorId ?? null,
            action: data.action,
            entityType: data.entityType,
            entityId: data.entityId ?? null,
            ipAddress: data.ipAddress ?? null,
            before: data.before ?? null,
            after: data.after ?? null,
            previousHash: data.previousHash ?? null,
            eventHash: data.eventHash,
            createdAt: data.createdAt,
          };
          events.push(event);
          return Promise.resolve(event);
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
      auditEvent: { findMany: vi.fn().mockImplementation(() => Promise.resolve(events)) },
    } as unknown as PrismaService;
    const crypto = {
      sha256: (value: string) => createHash('sha256').update(value).digest('hex'),
    } as unknown as CryptoService;
    const service = new AuditService(prisma, crypto);

    await service.record({
      actorId: 'admin-id',
      action: 'FIRST',
      entityType: 'Customer',
      entityId: 'customer-id',
      after: { z: 1, a: 2n },
    });
    await service.record({ action: 'SECOND', entityType: 'Worker', before: ['safe'] });

    await expect(service.verify()).resolves.toEqual({ valid: true, checked: 2 });
    expect(events[1]?.previousHash).toBe(events[0]?.eventHash);
    events[0]!.action = 'TAMPERED';
    await expect(service.verify()).resolves.toEqual({
      valid: false,
      checked: 0,
      brokenEventId: 'event-1',
    });
  });
});
