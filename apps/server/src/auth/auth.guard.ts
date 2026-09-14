import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import type { AuthenticatedAdmin } from './auth.types';
import { IS_PUBLIC_KEY } from './auth.decorators';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    const request = context
      .switchToHttp()
      .getRequest<FastifyRequest & { admin?: AuthenticatedAdmin }>();
    const token = request.cookies[this.auth.cookieName()];
    const session = await this.auth.getSession(token);
    if (!session) throw new UnauthorizedException('Authentication required');
    request.admin = session;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || csrf !== session.csrfToken) {
        throw new ForbiddenException('Invalid CSRF token');
      }
    }
    return true;
  }
}
