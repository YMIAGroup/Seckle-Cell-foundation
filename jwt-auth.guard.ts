import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Populates request.user from the Bearer access token. Applied
 * globally (main.ts) so no controller can forget it — DomainAccessGuard
 * depends on request.user existing. Routes marked @Public() (e.g.
 * POST /auth/login) skip this check.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers?.authorization;
    if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedException('AUTHENTICATION_REQUIRED');

    const token = authHeader.slice('Bearer '.length);
    try {
      const payload = this.jwt.verify(token, { secret: process.env.JWT_ACCESS_SECRET });
      // Real access tokens never carry a `type` claim -- only special-purpose
      // tokens do (e.g. the short-lived mfa_pending token issued mid-login,
      // signed with this same secret). Without this check, a token that only
      // proves "password was correct" could be replayed as a Bearer token
      // against any protected route, skipping the MFA step entirely.
      if (payload.type) throw new UnauthorizedException('AUTHENTICATION_REQUIRED');
      request.user = { id: payload.sub, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException('AUTHENTICATION_REQUIRED');
    }
  }
}
