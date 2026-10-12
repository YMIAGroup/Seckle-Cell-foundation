import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ServeStaticModule } from '@nestjs/serve-static';
import { ScheduleModule } from '@nestjs/schedule';
import { join } from 'path';
import { AuthModule } from './modules/auth/auth.module';
import { RbacModule } from './modules/rbac/rbac.module';
import { AuditModule } from './modules/audit/audit.module';
import { PolicyModule } from './modules/policy/policy.module';
import { CareModule } from './modules/care/care.module';
import { ProviderModule } from './modules/provider/provider.module';
import { FinanceModule } from './modules/finance/finance.module';
import { ClinicalModule } from './modules/clinical/clinical.module';
import { SafeguardingModule } from './modules/safeguarding/safeguarding.module';
import { DonorModule } from './modules/donor/donor.module';
import { AdminModule } from './modules/admin/admin.module';
import { PaymentChannelsModule } from './modules/payment-channels/payment-channels.module';
import { ReportingModule } from './modules/reporting/reporting.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

/**
 * All 7 domains wired: Identity/RBAC/Audit/Policy, Care, Provider, Finance,
 * Clinical, Safeguarding, Donor -- plus ReportingModule, a read-only
 * aggregation layer across all of them (not a business domain of its
 * own, but gated the same way via a REPORTING data-domain grant).
 */
@Module({
  imports: [
    // Baseline rate limit for every route: 100 requests/minute per IP.
    // Auth endpoints (login, signup, password reset) apply a much stricter
    // limit of their own via @Throttle() on top of this, since those are
    // the routes brute-force and enumeration attacks actually target.
    // Both limits are relaxed under NODE_ENV=test: the e2e suite legitimately
    // makes many auth calls back-to-back from one IP, which is exactly what
    // these limits exist to block in real traffic -- a real attacker and a
    // fast test run look the same to a request counter.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: process.env.NODE_ENV === 'test' ? 10_000 : 100 }]),
    // Powers the one scheduled job in this codebase (ProviderVerificationExpiryJob,
    // in ProviderModule) -- everything else here runs in direct response to an HTTP
    // request. Registered once, globally, the same way Nest's docs describe.
    ScheduleModule.forRoot(),
    // Minimal login/signup/dashboard frontend, served from the same app at /portal/*.
    // Same-origin, so these pages call the API with plain relative paths (fetch('/auth/login'))
    // and never need CORS configuration at all -- only a separate, externally-hosted frontend would.
    ServeStaticModule.forRoot({ rootPath: join(__dirname, '..', 'frontend'), serveRoot: '/portal' }),
    // Public marketing website, served from the same app at '/' -- this is what makes the
    // two previously-separate deliverables ("the website" and "the backend") one running
    // system on one port. Its own CTAs (Sign In, Donate -> account links, etc) point at
    // /portal/*, which works automatically because it's the same origin.
    // `exclude` stops this static handler from ever shadowing the API/portal routes below --
    // Nest registers ServeStaticModule entries as middleware in import order, so without the
    // excludes a request to e.g. /auth/login could in principle be swallowed here first.
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'website', 'public-website'),
      serveRoot: '/',
      exclude: ['/portal*', '/auth*', '/admin*', '/donor*', '/clinical*', '/safeguarding*', '/sponsorships*', '/finance*', '/api*', '/payment-channels*', '/reporting*', '/notifications*'],
    }),
    AuthModule, RbacModule, AuditModule, PolicyModule,
    CareModule, ProviderModule, FinanceModule,
    ClinicalModule, SafeguardingModule, DonorModule, AdminModule, PaymentChannelsModule, ReportingModule, NotificationsModule,
  ],
  providers: [
    // Applied globally alongside JwtAuthGuard (registered in AuthModule) --
    // NestJS runs every APP_GUARD provider in the chain, in registration order.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
