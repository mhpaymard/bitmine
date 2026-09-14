import { Body, Controller, Get, Ip, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthGuard } from './auth.guard';
import { CurrentAdmin, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import type { AuthenticatedAdmin } from './auth.types';
import { LoginDto, TotpCodeDto } from './dto/login.dto';

@Controller('api/v1/auth')
@UseGuards(AuthGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  async login(
    @Body() body: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = await this.auth.login(body, ip, reply);
    return { admin: session, csrfToken: session.csrfToken };
  }

  @Post('logout')
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(request.cookies[this.auth.cookieName()], reply);
    return { ok: true };
  }

  @Get('me')
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return { admin, csrfToken: admin.csrfToken };
  }

  @Post('totp/setup')
  setupTotp(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.auth.beginTotp(admin.id);
  }

  @Post('totp/enable')
  async enableTotp(@CurrentAdmin() admin: AuthenticatedAdmin, @Body() body: TotpCodeDto) {
    const backupCodes = await this.auth.enableTotp(admin.id, body.code);
    return { ok: true, backupCodes };
  }
}
