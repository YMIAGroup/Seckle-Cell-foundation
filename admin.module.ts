import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';
import { AdminRoleGuard } from './admin-role.guard';
import { DatabaseService } from '../../common/database.service';
import { AuditModule } from '../audit/audit.module';
import { EmailModule } from '../email/email.module';
import { PaymentChannelsModule } from '../payment-channels/payment-channels.module';
import { ProviderModule } from '../provider/provider.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [AuditModule, EmailModule, PaymentChannelsModule, ProviderModule, NotificationsModule],
  controllers: [AdminController],
  providers: [AdminService, AdminRoleGuard, DatabaseService],
})
export class AdminModule {}
