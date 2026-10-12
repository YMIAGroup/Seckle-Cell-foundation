import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { DatabaseService } from '../../common/database.service';
@Module({ providers: [AuditService, DatabaseService], exports: [AuditService] })
export class AuditModule {}
