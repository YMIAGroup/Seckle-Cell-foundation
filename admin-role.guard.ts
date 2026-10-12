import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../../common/database.service';

/**
 * Identity administration -- inviting users, unlocking accounts, approving
 * provider links -- is a distinct concern from CARE/CLINICAL/FINANCE/
 * SAFEGUARDING/DONOR data access. rbac.service.ts is explicit that
 * SYSTEM_ADMIN is deliberately NOT special-cased in that domain-access
 * matrix ("never special-case it here"), so gating these routes through
 * DomainAccessGuard would actually lock out the one account meant to use
 * them. This guard checks role membership directly instead: a separate,
 * explicit permission for "can administer accounts," rather than quietly
 * widening SYSTEM_ADMIN's reach into data domains through the back door.
 */
@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly db: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const userId = request.user?.id;
    if (!userId) throw new ForbiddenException('AUTHENTICATION_REQUIRED');

    const result = await this.db.query<{ code: string }>(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND r.code IN ('SYSTEM_ADMIN', 'FOUNDATION_ADMIN')`,
      [userId],
    );
    if (result.rowCount === 0) throw new ForbiddenException('AUTHORIZATION_DENIED');
    return true;
  }
}
