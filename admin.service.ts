import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../../common/database.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { nextReference } from '../../common/reference-generator';
import { generateUrlSafeToken, hashToken } from '../../common/token';
import { NotificationsService } from '../notifications/notifications.service';

const INVITE_TTL_HOURS = Number(process.env.ACTIVATION_TOKEN_TTL_HOURS || 24);

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
  ) {}

  async inviteUser(actorId: string, input: { email: string; roleCode: string; firstName: string; lastName: string }, ctx: { ip?: string; userAgent?: string }) {
    const email = input.email.trim().toLowerCase();

    const role = await this.db.query<{ id: string }>('SELECT id FROM roles WHERE code = $1', [input.roleCode]);
    if (role.rowCount === 0) throw new BadRequestException(`Unknown role code: ${input.roleCode}`);

    const existing = await this.db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE email = $1', [email]);
    if (existing.rows[0]) {
      throw new BadRequestException(`A user with this email already exists (status: ${existing.rows[0].status}). Use a different email, or handle that account directly.`);
    }

    const rawToken = generateUrlSafeToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000);
    const ref = await nextReference(this.db, 'seq_user_ref', 'SCF-USR');
    // password_hash stays NULL -- that's what distinguishes an invite from a self-signup still
    // pending activation, and is what acceptInvite() requires before it will honour the token.
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO users (user_ref, email, first_name, last_name, status, activation_token_hash, activation_token_expires_at)
       VALUES ($1,$2,$3,$4,'PENDING_ACTIVATION',$5,$6) RETURNING id`,
      [ref, email, input.firstName, input.lastName, hashToken(rawToken), expiresAt],
    );
    const userId = result.rows[0].id;
    await this.db.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [userId, role.rows[0].id]);

    const link = `${this.email.appBaseUrl()}/portal/accept-invite.html?token=${rawToken}`;
    await this.email.send({
      to: email,
      subject: "You've been invited to the SCCF platform",
      text: `${input.firstName}, you've been invited to join the SCCF platform as ${input.roleCode}.\n\nSet your password and activate your account here:\n${link}\n\nThis link expires in ${INVITE_TTL_HOURS} hours.`,
    });
    await this.audit.record({ actorId, action: 'USER_INVITED', entityType: 'USER', entityId: userId, newValue: { email, role: input.roleCode } });
    return { ok: true, userId };
  }

  async unlockAccount(actorId: string, targetUserId: string) {
    const result = await this.db.query('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1', [targetUserId]);
    if (result.rowCount === 0) throw new NotFoundException('USER_NOT_FOUND');
    await this.audit.record({ actorId, action: 'ACCOUNT_UNLOCKED_BY_ADMIN', entityType: 'USER', entityId: targetUserId });
    await this.notifications.create(targetUserId, 'ACCOUNT_UNLOCKED', 'Your account has been unlocked', 'An administrator has cleared your login lockout. You can sign in again now.');
    return { ok: true };
  }

  /** A deliberately small, fixed set of views for the admin dashboard -- not a general-purpose user search. */
  async listAttentionNeeded() {
    const locked = await this.db.query(
      `SELECT id, email, first_name, last_name, locked_until FROM users WHERE locked_until IS NOT NULL AND locked_until > now() ORDER BY locked_until DESC`,
    );
    const pendingActivation = await this.db.query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.created_at, r.code AS role_code
       FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
       WHERE u.status = 'PENDING_ACTIVATION' ORDER BY u.created_at DESC LIMIT 50`,
    );
    const pendingProviderLinks = await this.db.query(
      `SELECT pu.id, pu.claimed_organization_name, pu.created_at, u.email, u.first_name, u.last_name
       FROM provider_users pu JOIN users u ON u.id = pu.user_id
       WHERE pu.status = 'PENDING_LINK' ORDER BY pu.created_at DESC`,
    );
    return { locked: locked.rows, pendingActivation: pendingActivation.rows, pendingProviderLinks: pendingProviderLinks.rows };
  }

  async listProviders() {
    const result = await this.db.query(`SELECT id, provider_ref, legal_name, provider_type, status FROM providers ORDER BY legal_name`);
    return result.rows;
  }

  async linkProvider(actorId: string, providerUserId: string, providerId: string) {
    const providerUser = await this.db.query<{ id: string }>('SELECT id FROM provider_users WHERE id=$1 AND status=$2', [providerUserId, 'PENDING_LINK']);
    if (providerUser.rowCount === 0) throw new NotFoundException('PENDING_PROVIDER_LINK_NOT_FOUND');
    const provider = await this.db.query<{ id: string }>('SELECT id FROM providers WHERE id=$1', [providerId]);
    if (provider.rowCount === 0) throw new BadRequestException('PROVIDER_NOT_FOUND');

    await this.db.query(
      `UPDATE provider_users SET provider_id=$1, status='LINKED', linked_at=now(), linked_by=$2 WHERE id=$3`,
      [providerId, actorId, providerUserId],
    );
    await this.audit.record({ actorId, action: 'PROVIDER_USER_LINKED', entityType: 'PROVIDER_USER', entityId: providerUserId, newValue: { providerId } });

    const linkedUserId = await this.db.query<{ user_id: string }>('SELECT user_id FROM provider_users WHERE id=$1', [providerUserId]);
    await this.notifications.create(
      linkedUserId.rows[0].user_id,
      'PROVIDER_LINK_APPROVED',
      'Your provider account has been approved',
      'Your provider signup has been linked to your organisation and is ready to use.',
      { providerId },
    );
    return { ok: true };
  }
}
