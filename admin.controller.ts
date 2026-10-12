import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import type { Request } from 'express';
import { AdminService } from './admin.service';
import { AdminRoleGuard } from './admin-role.guard';
import { InviteUserDto } from './dto/invite-user.dto';
import { LinkProviderDto } from './dto/link-provider.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { PaymentChannelsService } from '../payment-channels/payment-channels.service';
import { SetChannelEnabledDto } from '../payment-channels/dto/set-channel-enabled.dto';
import { ProviderVerificationService } from '../provider/provider-verification.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(AdminRoleGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly paymentChannels: PaymentChannelsService,
    private readonly providerVerifications: ProviderVerificationService,
  ) {}

  @Post('invite')
  @ApiOperation({ summary: 'Invite a new staff (or any role) account. They set their own password via the emailed link.' })
  async invite(@Body() dto: InviteUserDto, @CurrentUser() user: { id: string }, @Req() req: Request) {
    return this.admin.inviteUser(user.id, dto, { ip: req.ip, userAgent: req.headers['user-agent'] as string | undefined });
  }

  @Post('users/:userId/unlock')
  @ApiOperation({ summary: 'Clear a login lockout early, without requiring the user to reset their password.' })
  async unlock(@Param('userId') userId: string, @CurrentUser() user: { id: string }) {
    return this.admin.unlockAccount(user.id, userId);
  }

  @Get('attention-needed')
  @ApiOperation({ summary: 'Locked accounts, pending activations, and pending provider links -- the admin dashboard home view.' })
  async attentionNeeded() {
    return this.admin.listAttentionNeeded();
  }

  @Get('providers')
  @ApiOperation({ summary: 'List verified provider organisations, for linking a pending provider-user to one.' })
  async providers() {
    return this.admin.listProviders();
  }

  @Post('provider-users/:providerUserId/link')
  @ApiOperation({ summary: 'Approve a provider signup by linking it to a verified provider organisation.' })
  async linkProvider(@Param('providerUserId') providerUserId: string, @Body() dto: LinkProviderDto, @CurrentUser() user: { id: string }) {
    return this.admin.linkProvider(user.id, providerUserId, dto.providerId);
  }

  @Get('payment-channels')
  @ApiOperation({ summary: 'List every donation channel, including disabled ones, for the admin dashboard toggle list.' })
  async listPaymentChannels() {
    return this.paymentChannels.listAll();
  }

  @Patch('payment-channels/:code')
  @ApiOperation({ summary: "Show or hide a donation channel on the public donate page (e.g. disable Stripe where it isn't usable, enable Crypto once ready)." })
  async setPaymentChannelEnabled(@Param('code') code: string, @Body() dto: SetChannelEnabledDto, @CurrentUser() user: { id: string }) {
    return this.paymentChannels.setEnabled(user.id, code, dto.enabled);
  }

  @Post('provider-verifications/run-expiry-check')
  @ApiOperation({ summary: 'Run the provider-verification expiry check now, instead of waiting for its daily 2am schedule. For ops and testing.' })
  async runProviderVerificationExpiryCheck(@CurrentUser() user: { id: string }) {
    return this.providerVerifications.runExpiryCheck(user.id);
  }
}
