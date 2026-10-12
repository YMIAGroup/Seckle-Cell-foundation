import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { DatabaseService } from '../../common/database.service';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { DonorModule } from '../donor/donor.module';

@Module({
  imports: [JwtModule.register({}), AuditModule, EmailModule, DonorModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    DatabaseService,
    // Global guard: every route requires a valid Bearer token unless
    // marked @Public(). Registered here (not in AppModule) keeps the
    // auth wiring self-contained in one module.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  exports: [AuthService],
})
export class AuthModule {}
