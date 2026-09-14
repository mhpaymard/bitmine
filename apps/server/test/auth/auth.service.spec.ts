import { AdminRole, EntityStatus } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply } from 'fastify';
import { AuthService } from '../../src/auth/auth.service';
import type { AuditService } from '../../src/audit/audit.service';
import type { Environment } from '../../src/config/environment';
import type { PrismaService } from '../../src/database/prisma.service';
import type { RedisService } from '../../src/redis/redis.service';
import type { CryptoService } from '../../src/security/crypto.service';

function service(status: EntityStatus, role: AdminRole = AdminRole.OWNER) {
  const session = {
    id: 'admin-id',
    email: 'old@example.com',
    displayName: 'Old',
    role: AdminRole.VIEWER,
    sessionId: 'session-id',
    csrfToken: 'csrf',
    createdAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  const client = {
    get: vi.fn().mockResolvedValue(JSON.stringify(session)),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
  const redis = {
    connect: vi.fn().mockResolvedValue(undefined),
    client,
  } as unknown as RedisService;
  const prisma = {
    admin: {
      findUnique: vi.fn().mockResolvedValue({
        email: 'current@example.com',
        displayName: 'Current',
        role,
        status,
      }),
    },
  } as unknown as PrismaService;
  const crypto = { sha256: vi.fn().mockReturnValue('token-hash') } as unknown as CryptoService;
  return {
    auth: new AuthService(
      prisma,
      redis,
      crypto,
      {} as AuditService,
      {} as ConfigService<Environment, true>,
    ),
    client,
  };
}

describe('AuthService session revalidation', () => {
  it('refreshes the role and identity from the database on every request', async () => {
    const { auth, client } = service(EntityStatus.ACTIVE, AdminRole.OPERATOR);
    const session = await auth.getSession('cookie-token');
    expect(session).toMatchObject({
      email: 'current@example.com',
      displayName: 'Current',
      role: AdminRole.OPERATOR,
    });
    expect(client.set).toHaveBeenCalledOnce();
  });

  it('revokes an existing session immediately when the admin is disabled', async () => {
    const { auth, client } = service(EntityStatus.DISABLED);
    await expect(auth.getSession('cookie-token')).resolves.toBeNull();
    expect(client.del).toHaveBeenCalledWith('auth:session:token-hash');
  });
});

describe('AuthService login throttling', () => {
  it('increments failures atomically and locks the account at the threshold', async () => {
    interface AdminUpdateInput {
      data: { failedLoginCount?: { increment: number }; lockedUntil?: Date };
      select?: { failedLoginCount: boolean };
    }
    const update = vi
      .fn<(input: AdminUpdateInput) => Promise<{ failedLoginCount: number }>>()
      .mockResolvedValueOnce({ failedLoginCount: 5 })
      .mockResolvedValueOnce({ failedLoginCount: 5 });
    const prisma = {
      admin: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'admin-id',
          email: 'owner@example.com',
          passwordHash: 'argon-hash',
          failedLoginCount: 4,
          lockedUntil: null,
          status: EntityStatus.ACTIVE,
          totpEnabled: false,
        }),
        update,
      },
    } as unknown as PrismaService;
    const crypto = {
      verifySecret: vi.fn().mockResolvedValue(false),
    } as unknown as CryptoService;
    const auditRecord = vi.fn().mockResolvedValue(undefined);
    const auth = new AuthService(
      prisma,
      {} as RedisService,
      crypto,
      { record: auditRecord } as unknown as AuditService,
      {} as ConfigService<Environment, true>,
    );

    await expect(
      auth.login(
        { email: 'owner@example.com', password: 'wrong' },
        '127.0.0.1',
        {} as FastifyReply,
      ),
    ).rejects.toThrow(/Invalid credentials/u);

    expect(update.mock.calls[0]?.[0]).toMatchObject({
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    expect(update.mock.calls[1]?.[0].data.lockedUntil).toBeInstanceOf(Date);
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTH_LOGIN_FAILED', ipAddress: '127.0.0.1' }),
    );
  });
});
