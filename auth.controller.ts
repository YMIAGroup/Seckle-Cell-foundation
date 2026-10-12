import { Body, Controller, Post, Get, Query, Req, Res, HttpCode } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { SignupProviderDto } from './dto/signup-provider.dto';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { ResendActivationDto } from './dto/resend-activation.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { MfaCodeDto } from './dto/mfa-code.dto';
import { MfaVerifyDto } from './dto/mfa-verify.dto';
import { MfaDisableDto } from './dto/mfa-disable.dto';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';

function ctxOf(req: Request) {
  return { ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined };
}

// A strict limiter on top of the 100/min global default (app.module.ts) --
// these specific routes are what brute-force, credential-stuffing, and
// signup-spam/enumeration attacks actually target. Relaxed under
// NODE_ENV=test for the same reason as the global limit (see app.module.ts).
const AUTH_THROTTLE = { default: { limit: process.env.NODE_ENV === 'test' ? 10_000 : 5, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @ApiOperation({ summary: 'Log in with email + password. Returns tokens directly, or an mfa_token if MFA is enabled.' })
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.authService.login(dto.email, dto.password, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('signup')
  @ApiOperation({ summary: 'Self-service donor signup. Always returns a generic message; an activation email is sent if appropriate.' })
  async signup(@Body() dto: SignupDto, @Req() req: Request) {
    return this.authService.signupDonor(dto, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('signup/caregiver')
  @ApiOperation({ summary: 'Self-service caregiver signup. A case worker links the account to a child\'s record afterwards.' })
  async signupCaregiver(@Body() dto: SignupDto, @Req() req: Request) {
    return this.authService.signupCaregiver(dto, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('signup/provider')
  @ApiOperation({ summary: 'Self-service provider-contact signup. Account is email-verified but functionally inert until an admin links it to a verified provider organisation.' })
  async signupProvider(@Body() dto: SignupProviderDto, @Req() req: Request) {
    return this.authService.signupProvider(dto, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('invite/accept')
  @ApiOperation({ summary: 'Accept an admin-issued invite: sets a first password and activates the account in one step.' })
  async acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request) {
    return this.authService.acceptInvite(dto.token, dto.newPassword, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('resend-activation')
  @ApiOperation({ summary: 'Request a fresh activation email.' })
  async resendActivation(@Body() dto: ResendActivationDto, @Req() req: Request) {
    return this.authService.resendActivation(dto.email, ctxOf(req));
  }

  @Public()
  @Get('activate')
  @ApiOperation({ summary: 'Activation link target (clicked from the email). Returns a small confirmation page.' })
  async activate(@Query('token') token: string, @Req() req: Request, @Res() res: Response) {
    const result = await this.authService.activate(token, ctxOf(req));
    res.status(result.ok ? 200 : 400).type('html').send(result.html);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('forgot-password')
  @ApiOperation({ summary: 'Request a password-reset email. Always returns a generic message.' })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    return this.authService.forgotPassword(dto.email, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('reset-password')
  @ApiOperation({ summary: 'Complete a password reset using the token from the email.' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    return this.authService.resetPassword(dto.token, dto.newPassword, ctxOf(req));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('refresh')
  @ApiOperation({ summary: 'Exchange a refresh token for a new access + refresh token pair (rotation: the old one is revoked).' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() req: Request) {
    return this.authService.refresh(dto.refreshToken, ctxOf(req));
  }

  @Get('me')
  @ApiOperation({ summary: 'The logged-in user\'s own profile and roles -- used by the portal to decide which dashboard to show.' })
  async me(@CurrentUser() user: { id: string }) {
    return this.authService.me(user.id);
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke a refresh token (that session only -- other devices stay logged in).' })
  async logout(@Body() dto: RefreshTokenDto, @CurrentUser() user: { id: string }) {
    return this.authService.logout(dto.refreshToken, user.id);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('mfa/verify')
  @ApiOperation({ summary: 'Second step of login when MFA is enabled: exchange the mfa_token + a TOTP code for real tokens.' })
  async verifyMfa(@Body() dto: MfaVerifyDto, @Req() req: Request) {
    return this.authService.verifyMfa(dto.mfaToken, dto.code, ctxOf(req));
  }

  @Post('mfa/setup')
  @ApiOperation({ summary: 'Start enabling MFA: generates a TOTP secret (not yet active until confirmed).' })
  async setupMfa(@CurrentUser() user: { id: string }) {
    return this.authService.setupMfa(user.id);
  }

  @Post('mfa/verify-setup')
  @ApiOperation({ summary: 'Confirm MFA setup by proving possession of the authenticator (one valid code).' })
  async verifyMfaSetup(@Body() dto: MfaCodeDto, @CurrentUser() user: { id: string }) {
    return this.authService.verifyMfaSetup(user.id, dto.code);
  }

  @Post('mfa/disable')
  @ApiOperation({ summary: 'Turn MFA off. Requires re-entering the password.' })
  async disableMfa(@Body() dto: MfaDisableDto, @CurrentUser() user: { id: string }) {
    return this.authService.disableMfa(user.id, dto.password);
  }
}
