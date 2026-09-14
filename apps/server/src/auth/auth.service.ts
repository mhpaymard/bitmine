import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityStatus } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { AuditService } from '../audit/audit.service';
import type { Environment } from '../config/environment';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CryptoService } from '../security/crypto.service';
import type { LoginDto } from './dto/login.dto';
import { generateTotpSecret, totpUri, verifyTotp } from './totp';
import type { SessionPayload } from './auth.types';

const SESSION_COOKIE = 'mitm_session';
const SESSION_SECONDS = 8 * 60 * 60;
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$JHNhbHQxMjM0NTY3OA$RZ9PZ1jC3LM1I1bs2N0DgPzjF0KnxY3Q5kJATPR9xJ0';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  private sessionKey(token: string): string {
    return `auth:session:${this.crypto.sha256(token)}`;
  }

  async login(dto: LoginDto, ipAddress: string, reply: FastifyReply): Promise<SessionPayload> {
    const email = dto.email.trim().toLowerCase();
    const admin = await this.prisma.admin.findUnique({ where: { email } });
    const passwordOk = await this.crypto.verifySecret(
      admin?.passwordHash ?? DUMMY_HASH,
      dto.password,
    );
    const locked = Boolean(admin?.lockedUntil && admin.lockedUntil > new Date());
    let totpOk = true;
    let backupCodeId: string | undefined;
    if (admin?.totpEnabled) {
      totpOk = Boolean(
        dto.totpCode &&
        admin.totpSecretCiphertext &&
        verifyTotp(
          this.crypto.decrypt(admin.totpSecretCiphertext, `admin:${admin.id}:totp`),
          dto.totpCode,
        ),
      );
      if (!totpOk && passwordOk && !locked && dto.totpCode) {
        const backupCodes = await this.prisma.adminBackupCode.findMany({
          where: { adminId: admin.id, usedAt: null },
          select: { id: true, codeHash: true },
        });
        const normalized = dto.totpCode.replace(/\s|-/gu, '').toUpperCase();
        for (const backupCode of backupCodes) {
          if (await this.crypto.verifySecret(backupCode.codeHash, normalized)) {
            backupCodeId = backupCode.id;
            totpOk = true;
            break;
          }
        }
      }
    }
    if (!admin || !passwordOk || !totpOk || locked || admin.status !== EntityStatus.ACTIVE) {
      if (admin) {
        const failed = await this.prisma.admin.update({
          where: { id: admin.id },
          data: { failedLoginCount: { increment: 1 } },
          select: { failedLoginCount: true },
        });
        if (failed.failedLoginCount >= 5 && !locked) {
          await this.prisma.admin.update({
            where: { id: admin.id },
            data: { lockedUntil: new Date(Date.now() + 15 * 60_000) },
          });
        }
      }
      await this.audit.record({
        action: 'AUTH_LOGIN_FAILED',
        entityType: 'Admin',
        entityId: admin?.id,
        ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials or TOTP');
    }

    if (backupCodeId) {
      const consumed = await this.prisma.adminBackupCode.updateMany({
        where: { id: backupCodeId, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new UnauthorizedException('Backup code has already been used');
    }

    await this.redis.connect();
    const token = this.crypto.randomToken(32);
    const now = new Date().toISOString();
    const session: SessionPayload = {
      id: admin.id,
      email: admin.email,
      displayName: admin.displayName,
      role: admin.role,
      sessionId: this.crypto.randomToken(16),
      csrfToken: this.crypto.randomToken(24),
      createdAt: now,
      lastSeenAt: now,
    };
    await this.redis.client.set(
      this.sessionKey(token),
      JSON.stringify(session),
      'EX',
      SESSION_SECONDS,
    );
    const secure = this.config.get('NODE_ENV', { infer: true }) === 'production';
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      path: '/',
      maxAge: SESSION_SECONDS,
    });
    await this.prisma.admin.update({
      where: { id: admin.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await this.audit.record({
      actorId: admin.id,
      action: 'AUTH_LOGIN',
      entityType: 'Admin',
      entityId: admin.id,
      ipAddress,
    });
    return session;
  }

  async getSession(token?: string): Promise<SessionPayload | null> {
    if (!token) return null;
    await this.redis.connect();
    const key = this.sessionKey(token);
    const raw = await this.redis.client.get(key);
    if (!raw) return null;
    const session = JSON.parse(raw) as SessionPayload;
    const admin = await this.prisma.admin.findUnique({
      where: { id: session.id },
      select: { email: true, displayName: true, role: true, status: true },
    });
    if (!admin || admin.status !== EntityStatus.ACTIVE) {
      await this.redis.client.del(key);
      return null;
    }
    session.email = admin.email;
    session.displayName = admin.displayName;
    session.role = admin.role;
    session.lastSeenAt = new Date().toISOString();
    await this.redis.client.set(key, JSON.stringify(session), 'EX', SESSION_SECONDS);
    return session;
  }

  async logout(token: string | undefined, reply: FastifyReply): Promise<void> {
    if (token) await this.redis.client.del(this.sessionKey(token));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  async beginTotp(adminId: string): Promise<{ secret: string; uri: string }> {
    const admin = await this.prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
    const secret = generateTotpSecret();
    await this.prisma.admin.update({
      where: { id: adminId },
      data: {
        totpSecretCiphertext: this.crypto.encrypt(secret, `admin:${adminId}:totp`),
        totpEnabled: false,
      },
    });
    await this.audit.record({
      actorId: adminId,
      action: 'AUTH_TOTP_SETUP_STARTED',
      entityType: 'Admin',
      entityId: adminId,
    });
    return { secret, uri: totpUri(secret, admin.email) };
  }

  async enableTotp(adminId: string, code: string): Promise<string[]> {
    const admin = await this.prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
    if (!admin.totpSecretCiphertext) throw new UnauthorizedException('TOTP setup has not started');
    const secret = this.crypto.decrypt(admin.totpSecretCiphertext, `admin:${adminId}:totp`);
    if (!verifyTotp(secret, code)) throw new UnauthorizedException('Invalid TOTP code');
    const backupCodes = Array.from({ length: 10 }, () =>
      this.crypto.randomToken(12).replace(/[-_]/gu, 'A').slice(0, 12).toUpperCase(),
    );
    const hashes: string[] = [];
    for (const backupCode of backupCodes) hashes.push(await this.crypto.hashSecret(backupCode));
    await this.prisma.$transaction([
      this.prisma.admin.update({ where: { id: adminId }, data: { totpEnabled: true } }),
      this.prisma.adminBackupCode.deleteMany({ where: { adminId } }),
      this.prisma.adminBackupCode.createMany({
        data: hashes.map((codeHash) => ({ adminId, codeHash })),
      }),
    ]);
    await this.audit.record({
      actorId: adminId,
      action: 'AUTH_TOTP_ENABLED',
      entityType: 'Admin',
      entityId: adminId,
    });
    return backupCodes;
  }

  async assertTotp(adminId: string, code: string): Promise<void> {
    const admin = await this.prisma.admin.findUniqueOrThrow({ where: { id: adminId } });
    if (!admin.totpEnabled || !admin.totpSecretCiphertext) {
      throw new UnauthorizedException('TOTP must be enabled before approving payouts');
    }
    const secret = this.crypto.decrypt(admin.totpSecretCiphertext, `admin:${adminId}:totp`);
    if (!verifyTotp(secret, code)) throw new UnauthorizedException('Invalid TOTP code');
  }

  cookieName(): string {
    return SESSION_COOKIE;
  }
}
