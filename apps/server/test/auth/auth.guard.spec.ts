import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../../src/auth/auth.guard';
import type { AuthService } from '../../src/auth/auth.service';

function context(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  it('rejects a missing server-side session', async () => {
    const auth = {
      cookieName: () => 'mitm_session',
      getSession: vi.fn().mockResolvedValue(null),
    } as unknown as AuthService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) };
    const guard = new AuthGuard(auth, reflector as never);
    await expect(
      guard.canActivate(context({ cookies: {}, method: 'GET', headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('requires the exact CSRF token for mutations', async () => {
    const auth = {
      cookieName: () => 'mitm_session',
      getSession: vi.fn().mockResolvedValue({ csrfToken: 'expected' }),
    } as unknown as AuthService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) };
    const guard = new AuthGuard(auth, reflector as never);
    await expect(
      guard.canActivate(
        context({
          cookies: { mitm_session: 'token' },
          method: 'POST',
          headers: { 'x-csrf-token': 'wrong' },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('attaches the authenticated administrator on a safe request', async () => {
    const session = { id: 'admin', csrfToken: 'csrf' };
    const request = { cookies: { mitm_session: 'token' }, method: 'GET', headers: {} } as Record<
      string,
      unknown
    >;
    const auth = {
      cookieName: () => 'mitm_session',
      getSession: vi.fn().mockResolvedValue(session),
    } as unknown as AuthService;
    const reflector = { getAllAndOverride: vi.fn().mockReturnValue(false) };
    const guard = new AuthGuard(auth, reflector as never);
    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.admin).toBe(session);
  });
});
