import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../common/database.service';
export interface AuditEventInput {
  actorId: string | null; action: string; entityType: string; entityId?: string | null;
  previousValue?: unknown; newValue?: unknown; ipAddress?: string | null; userAgent?: string | null;
}
@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}
  async record(event: AuditEventInput): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_events (actor_id, action, entity_type, entity_id, previous_value, new_value, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [event.actorId, event.action, event.entityType, event.entityId ?? null,
        event.previousValue ? JSON.stringify(event.previousValue) : null,
        event.newValue ? JSON.stringify(event.newValue) : null, event.ipAddress ?? null, event.userAgent ?? null],
    );
  }
  async recordDataAccess(p: { userId: string; beneficiaryId: string | null; dataDomain: string; accessType: string; purpose?: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO data_access_logs (user_id, beneficiary_id, data_domain, access_type, purpose) VALUES ($1,$2,$3,$4,$5)`,
      [p.userId, p.beneficiaryId, p.dataDomain, p.accessType, p.purpose ?? null],
    );
  }
}
