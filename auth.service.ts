import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DatabaseService } from '../../common/database.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { DonorService } from '../donor/donor.service';
import { nextReference } from '../../common/reference-generator';
import { generateUrlSafeToken, hashToken, hashesMatch } from '../../common/token';
import { generateTotpSecret, totpUri, verifyTotp } from '../../common/totp';
import { encryptAtRest, decryptAtRest } from '../../common/crypto-at-rest';
import { passwordPolicyErrors } from './password-policy';

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const ACTIVATION_TTL_HOURS = Number(process.env.ACTIVATION_TOKEN_TTL_HOURS || 24);
const RESET_TTL_MINUTES = Number(process.env.PASSWORD_RESET_TOKEN_TTL_MINUTES || 60);
const LOCKOUT_THRESHOLD = Number(process.env.LOGIN_LOCKOUT_THRESHOLD || 5);
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);
const REFRESH_TTL_DAYS = 30;
const MFA_PENDING_TTL_MINUTES = 5;

interface LoginUserRow {
  id: string; email: string; password_hash: string | null; status: string;
  mfa_enabled: boolean; mfa_secret: string | null; failed_login_count: number; locked_until: string | null;
  must_change_password: boolean;
}

/** Generic response for anything that must not reveal whether an email exists (signup, forgot-password, resend-activation). */
const GENERIC_CHECK_EMAIL = { message: 'If that email is registered, check your inbox for next steps.' };

type Ctx = { ip?: string; userAgent?: string };
type SignupInput = { email: string; password: string; firstName: string; lastName: string; phone?: string };

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly donor: DonorService,
  ) {}

  // ---------------------------------------------------------------- signup

  async signupDonor(input: SignupInput, ctx: Ctx) {
    await this.selfServiceSignup('DONOR', input, ctx, {
      subject: 'Activate your SCCF donor account',
      intro: 'Welcome to the Sickle Cell Child Care Foundation.',
    });
    return GENERIC_CHECK_EMAIL;
  }

  async signupCaregiver(input: SignupInput, ctx: Ctx) {
    await this.selfServiceSignup('CAREGIVER', input, ctx, {
      subject: 'Activate your SCCF caregiver account',
      intro: "Welcome to the Sickle Cell Child Care Foundation. Once your account is active, a case worker will help link it to your child's record.",
    });
    return GENERIC_CHECK_EMAIL;
  }

  async signupProvider(input: SignupInput & { organizationName: string }, ctx: Ctx) {
    const result = await this.selfServiceSignup('PROVIDER_USER', input, ctx, {
      subject: 'Your SCCF provider account request',
      intro: `Thanks for registering interest on behalf of ${input.organizationName}. Activating your email is the first step -- an administrator still needs to verify and link your account to ${input.organizationName}'s record before you can access anything, so please allow time for that review.`,
    });
    if (result.userId) {
      await this.db.query(
        `INSERT INTO provider_users (user_id, claimed_organization_name) VALUES ($1,$2)`,
        [result.userId, input.organizationName],
      );
    }
    return GENERIC_CHECK_EMAIL;
  }

  /** Shared by all three self-service signup paths; each caller supplies its own role and email copy. */
  private async selfServiceSignup(
    roleCode: 'DONOR' | 'CAREGIVER' | 'PROVIDER_USER',
    input: SignupInput,
    ctx: Ctx,
    emailCopy: { subject: string; intro: string },
  ): Promise<{ userId: string | null }> {
    const passwordErrors = passwordPolicyErrors(input.password);
    if (passwordErrors.length) throw new BadRequestException(passwordErrors.join(' '));

    const email = input.email.trim().toLowerCase();
    const existing = await this.db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE email = $1', [email]);
    const existingUser = existing.rows[0];

    if (existingUser?.status === 'ACTIVE') {
      // Don't confirm the email is taken -- but do tell the real owner, so an
      // attacker probing for registered emails can't learn anything useful.
      await this.email.send({
        to: email,
        subject: 'Someone tried to sign up with your email',
        text: `Someone just tried to create a new SCCF account using this email address, which already has one.\n\nIf this was you, you can simply log in. If it wasn't, no action is needed -- your account is unaffected.`,
      });
      await this.audit.record({ actorId: null, action: 'SIGNUP_ATTEMPT_EXISTING_ACTIVE', entityType: 'USER', entityId: existingUser.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      return { userId: null };
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const rawToken = generateUrlSafeToken();
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 3600_000);

    let userId: string;
    if (existingUser) {
      // A previous signup never got activated -- reissue a fresh token rather than creating a duplicate row.
      userId = existingUser.id;
      await this.db.query(
        `UPDATE users SET password_hash=$1, first_name=$2, last_name=$3, phone=$4,
           activation_token_hash=$5, activation_token_expires_at=$6, updated_at=now() WHERE id=$7`,
        [passwordHash, input.firstName, input.lastName, input.phone ?? null, tokenHash, expiresAt, userId],
      );
    } else {
      const ref = await nextReference(this.db, 'seq_user_ref', 'SCF-USR');
      const result = await this.db.query<{ id: string }>(
        `INSERT INTO users (user_ref, email, password_hash, first_name, last_name, phone, status, activation_token_hash, activation_token_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'PENDING_ACTIVATION',$7,$8) RETURNING id`,
        [ref, email, passwordHash, input.firstName, input.lastName, input.phone ?? null, tokenHash, expiresAt],
      );
      userId = result.rows[0].id;
      await this.db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [userId, roleCode]);
    }

    await this.sendActivationEmail(email, rawToken, emailCopy);
    await this.audit.record({ actorId: userId, action: 'SIGNUP', entityType: 'USER', entityId: userId, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    return { userId };
  }

  private async sendActivationEmail(email: string, rawToken: string, copy: { subject: string; intro: string }): Promise<void> {
    const link = `${this.email.appBaseUrl()}/auth/activate?token=${rawToken}`;
    await this.email.send({
      to: email,
      subject: copy.subject,
      text: `${copy.intro}\n\nActivate your account by opening this link:\n${link}\n\nThis link expires in ${ACTIVATION_TTL_HOURS} hours. If you didn't request this, you can ignore this email.`,
    });
  }

  async resendActivation(email: string, ctx: Ctx) {
    const normalized = email.trim().toLowerCase();
    const result = await this.db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE email = $1', [normalized]);
    const user = result.rows[0];
    if (user?.status === 'PENDING_ACTIVATION') {
      const rawToken = generateUrlSafeToken();
      const expiresAt = new Date(Date.now() + ACTIVATION_TTL_HOURS * 3600_000);
      await this.db.query('UPDATE users SET activation_token_hash=$1, activation_token_expires_at=$2 WHERE id=$3', [hashToken(rawToken), expiresAt, user.id]);
      await this.sendActivationEmail(normalized, rawToken, { subject: 'Activate your SCCF account', intro: 'Welcome to the Sickle Cell Child Care Foundation.' });
      await this.audit.record({ actorId: user.id, action: 'ACTIVATION_RESENT', entityType: 'USER', entityId: user.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    }
    return GENERIC_CHECK_EMAIL; // same response whether or not the email exists or is already active
  }

  /** Returns a tiny self-contained HTML page -- works even before a donor-portal frontend exists to host one. */
  async activate(rawToken: string, ctx: Ctx): Promise<{ ok: boolean; html: string }> {
    if (!rawToken) return { ok: false, html: activationPage(false, 'No activation token was provided.') };
    const tokenHash = hashToken(rawToken);
    const result = await this.db.query<{ id: string; activation_token_hash: string; activation_token_expires_at: string }>(
      `SELECT id, activation_token_hash, activation_token_expires_at FROM users
       WHERE status = 'PENDING_ACTIVATION' AND activation_token_hash IS NOT NULL`,
    );
    // Compared in application code (not WHERE token_hash = $1) so the lookup is a constant-time
    // comparison per row rather than letting the database's index short-circuit on a partial match.
    const match = result.rows.find((r) => hashesMatch(r.activation_token_hash, tokenHash));
    if (!match || new Date(match.activation_token_expires_at).getTime() < Date.now()) {
      return { ok: false, html: activationPage(false, 'This activation link is invalid or has expired. Request a new one from the sign-up page.') };
    }
    await this.db.query(
      `UPDATE users SET status='ACTIVE', email_verified_at=now(), activation_token_hash=NULL, activation_token_expires_at=NULL, updated_at=now() WHERE id=$1`,
      [match.id],
    );
    // Only a DONOR gets a donor_profile -- this activate() path is now shared by donor, caregiver and
    // provider signup, and must not quietly create a donor profile for the other two.
    const roles = await this.db.query<{ code: string }>(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [match.id],
    );
    if (roles.rows.some((r) => r.code === 'DONOR')) {
      await this.donor.createDonorProfile(match.id, {}, match.id);
    }
    await this.audit.record({ actorId: match.id, action: 'ACCOUNT_ACTIVATED', entityType: 'USER', entityId: match.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    const isProvider = roles.rows.some((r) => r.code === 'PROVIDER_USER');
    const message = isProvider
      ? 'Your email is confirmed. An administrator still needs to verify and link your account before you can access anything -- you will not be able to log in to any provider features until that happens.'
      : 'Your account is active. You can now log in.';
    return { ok: true, html: activationPage(true, message) };
  }

  /** Accept an admin-issued invite: the invitee didn't choose a password at invite time, so this does activation + first-password-set in one step. */
  async acceptInvite(rawToken: string, newPassword: string, ctx: Ctx) {
    const errors = passwordPolicyErrors(newPassword);
    if (errors.length) throw new BadRequestException(errors.join(' '));

    const tokenHash = hashToken(rawToken);
    const result = await this.db.query<{ id: string; activation_token_hash: string; activation_token_expires_at: string; password_hash: string | null }>(
      `SELECT id, activation_token_hash, activation_token_expires_at, password_hash FROM users
       WHERE status = 'PENDING_ACTIVATION' AND activation_token_hash IS NOT NULL AND password_hash IS NULL`,
    );
    const match = result.rows.find((r) => hashesMatch(r.activation_token_hash, tokenHash));
    if (!match || new Date(match.activation_token_expires_at).getTime() < Date.now()) {
      throw new BadRequestException('INVITE_TOKEN_INVALID_OR_EXPIRED');
    }
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.db.query(
      `UPDATE users SET password_hash=$1, status='ACTIVE', email_verified_at=now(),
         activation_token_hash=NULL, activation_token_expires_at=NULL, updated_at=now() WHERE id=$2`,
      [passwordHash, match.id],
    );
    await this.audit.record({ actorId: match.id, action: 'INVITE_ACCEPTED', entityType: 'USER', entityId: match.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    return { ok: true };
  }

  // ----------------------------------------------------------------- login

  async login(email: string, password: string, ctx: { ip?: string; userAgent?: string }) {
    const result = await this.db.query<LoginUserRow>(
      `SELECT id, email, password_hash, status, mfa_enabled, mfa_secret, failed_login_count, locked_until, must_change_password FROM users WHERE email = $1`,
      [email.trim().toLowerCase()],
    );
    const user = result.rows[0];

    if (user?.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      await this.audit.record({ actorId: user.id, action: 'LOGIN_BLOCKED_LOCKED', entityType: 'USER', entityId: user.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      throw new UnauthorizedException('ACCOUNT_TEMPORARILY_LOCKED');
    }

    // Compare against a real bcrypt hash even for an unknown email, so response timing doesn't leak which case failed.
    const passwordHash = user?.password_hash ?? '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinval';
    const valid = await bcrypt.compare(password, passwordHash);

    if (!user || !valid) {
      if (user) await this.registerFailedLogin(user);
      await this.audit.record({ actorId: user?.id ?? null, action: 'AUTHENTICATION_FAILED', entityType: 'USER', entityId: user?.id ?? null, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      throw new UnauthorizedException('AUTHENTICATION_FAILED');
    }

    if (user.status === 'PENDING_ACTIVATION') throw new UnauthorizedException('ACCOUNT_NOT_ACTIVATED');
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('AUTHENTICATION_FAILED');

    if (user.failed_login_count > 0 || user.locked_until) {
      await this.db.query('UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1', [user.id]);
    }

    if (user.mfa_enabled) {
      const mfaToken = this.jwt.sign({ sub: user.id, type: 'mfa_pending' }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: `${MFA_PENDING_TTL_MINUTES}m` });
      await this.audit.record({ actorId: user.id, action: 'LOGIN_AWAITING_MFA', entityType: 'USER', entityId: user.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      return { requires_mfa: true, mfa_token: mfaToken, expires_in: MFA_PENDING_TTL_MINUTES * 60 };
    }

    await this.audit.record({ actorId: user.id, action: 'LOGIN', entityType: 'USER', entityId: user.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    return this.issueSession(user.id, user.email, ctx, user.must_change_password);
  }

  private async registerFailedLogin(user: { id: string; failed_login_count: number }): Promise<void> {
    const next = user.failed_login_count + 1;
    const lockedUntil = next >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null;
    await this.db.query('UPDATE users SET failed_login_count=$1, locked_until=$2 WHERE id=$3', [next, lockedUntil, user.id]);
    if (lockedUntil) await this.audit.record({ actorId: user.id, action: 'ACCOUNT_LOCKED', entityType: 'USER', entityId: user.id });
  }

  // ------------------------------------------------------------------- mfa

  async setupMfa(userId: string) {
    const secret = generateTotpSecret();
    await this.db.query('UPDATE users SET mfa_secret_pending=$1 WHERE id=$2', [encryptAtRest(secret, process.env.MFA_ENCRYPTION_KEY as string), userId]);
    const userRow = await this.db.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [userId]);
    // The plaintext secret is returned here once, for the QR code / manual-entry step, and never again --
    // every subsequent read of this secret (verify-setup, login verification) decrypts the stored column instead.
    return { secret, otpauth_url: totpUri(secret, userRow.rows[0].email) };
  }

  async verifyMfaSetup(userId: string, code: string) {
    const result = await this.db.query<{ mfa_secret_pending: string | null }>('SELECT mfa_secret_pending FROM users WHERE id=$1', [userId]);
    const encryptedPending = result.rows[0]?.mfa_secret_pending;
    const pending = encryptedPending ? decryptAtRest(encryptedPending, process.env.MFA_ENCRYPTION_KEY as string) : null;
    if (!pending || !verifyTotp(pending, code)) throw new BadRequestException('INVALID_MFA_CODE');
    await this.db.query('UPDATE users SET mfa_secret=mfa_secret_pending, mfa_secret_pending=NULL, mfa_enabled=TRUE WHERE id=$1', [userId]);
    await this.audit.record({ actorId: userId, action: 'MFA_ENABLED', entityType: 'USER', entityId: userId });
    return { mfa_enabled: true };
  }

  async verifyMfa(mfaToken: string, code: string, ctx: { ip?: string; userAgent?: string }) {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwt.verify(mfaToken, { secret: process.env.JWT_ACCESS_SECRET });
    } catch {
      throw new UnauthorizedException('MFA_CHALLENGE_EXPIRED');
    }
    if (payload.type !== 'mfa_pending') throw new UnauthorizedException('MFA_CHALLENGE_EXPIRED');

    const result = await this.db.query<{ email: string; mfa_secret: string | null; must_change_password: boolean }>(
      'SELECT email, mfa_secret, must_change_password FROM users WHERE id=$1', [payload.sub],
    );
    const user = result.rows[0];
    const mfaSecret = user?.mfa_secret ? decryptAtRest(user.mfa_secret, process.env.MFA_ENCRYPTION_KEY as string) : null;
    if (!mfaSecret || !verifyTotp(mfaSecret, code)) {
      await this.audit.record({ actorId: payload.sub, action: 'MFA_VERIFY_FAILED', entityType: 'USER', entityId: payload.sub, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      throw new UnauthorizedException('INVALID_MFA_CODE');
    }
    await this.audit.record({ actorId: payload.sub, action: 'LOGIN', entityType: 'USER', entityId: payload.sub, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    return this.issueSession(payload.sub, user.email, ctx, user.must_change_password);
  }

  async disableMfa(userId: string, password: string) {
    const result = await this.db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [userId]);
    const ok = result.rows[0]?.password_hash && (await bcrypt.compare(password, result.rows[0].password_hash));
    if (!ok) throw new UnauthorizedException('AUTHENTICATION_FAILED');
    await this.db.query('UPDATE users SET mfa_enabled=FALSE, mfa_secret=NULL, mfa_secret_pending=NULL WHERE id=$1', [userId]);
    await this.audit.record({ actorId: userId, action: 'MFA_DISABLED', entityType: 'USER', entityId: userId });
    return { mfa_enabled: false };
  }

  // --------------------------------------------------------- session/token

  private async issueSession(userId: string, email: string, ctx: { ip?: string; userAgent?: string }, mustChangePassword = false) {
    const accessToken = this.jwt.sign({ sub: userId, email }, { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' });
    const refreshToken = this.jwt.sign({ sub: userId, type: 'refresh' }, { secret: process.env.JWT_REFRESH_SECRET, expiresIn: `${REFRESH_TTL_DAYS}d` });
    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, ip_address, user_agent) VALUES ($1,$2,$3,$4,$5)`,
      [userId, hashToken(refreshToken), new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000), ctx.ip ?? null, ctx.userAgent ?? null],
    );
    return {
      access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: 900, requires_mfa: false,
      // Surfaced so a client can prompt immediately; enforced by nothing server-side beyond this flag
      // today (see docs/OPEN_ITEMS.md) -- the account itself is fully usable in the meantime via the
      // already-tested forgot-password/reset-password flow, which is how a bootstrap admin sets a real password.
      must_change_password: mustChangePassword,
    };
  }

  async refresh(rawRefreshToken: string, ctx: { ip?: string; userAgent?: string }) {
    let payload: { sub: string; type: string };
    try {
      payload = this.jwt.verify(rawRefreshToken, { secret: process.env.JWT_REFRESH_SECRET });
    } catch {
      throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('REFRESH_TOKEN_INVALID');

    const tokenHash = hashToken(rawRefreshToken);
    const stored = await this.db.query<{ id: string; revoked_at: string | null; expires_at: string }>(
      'SELECT id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash=$1 AND user_id=$2', [tokenHash, payload.sub],
    );
    const row = stored.rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() < Date.now()) {
      // A revoked-but-structurally-valid refresh token being replayed is a strong signal of theft:
      // respond the same as "invalid" to the caller, but it's worth watching this audit action in production.
      await this.audit.record({ actorId: payload.sub, action: 'REFRESH_TOKEN_REUSE_OR_INVALID', entityType: 'USER', entityId: payload.sub, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
      throw new UnauthorizedException('REFRESH_TOKEN_INVALID');
    }

    const userResult = await this.db.query<{ email: string; status: string }>('SELECT email, status FROM users WHERE id=$1', [payload.sub]);
    const user = userResult.rows[0];
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('REFRESH_TOKEN_INVALID');

    // Rotate: the old token is consumed the instant it's used, so a stolen-and-replayed refresh token stops working after the legitimate client's next refresh.
    const session = await this.issueSession(payload.sub, user.email, ctx);
    const newHash = hashToken(session.refresh_token);
    const newRow = await this.db.query<{ id: string }>('SELECT id FROM refresh_tokens WHERE token_hash=$1', [newHash]);
    await this.db.query('UPDATE refresh_tokens SET revoked_at=now(), replaced_by_id=$1 WHERE id=$2', [newRow.rows[0].id, row.id]);
    return session;
  }

  async logout(rawRefreshToken: string, actorId: string) {
    await this.db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL', [hashToken(rawRefreshToken)]);
    await this.audit.record({ actorId, action: 'LOGOUT', entityType: 'USER', entityId: actorId });
    return { ok: true };
  }

  // ---------------------------------------------------------- reset / etc.

  async forgotPassword(email: string, ctx: { ip?: string; userAgent?: string }) {
    const normalized = email.trim().toLowerCase();
    const result = await this.db.query<{ id: string; status: string }>('SELECT id, status FROM users WHERE email=$1', [normalized]);
    const user = result.rows[0];
    if (user?.status === 'ACTIVE') {
      const rawToken = generateUrlSafeToken();
      const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);
      await this.db.query('UPDATE users SET password_reset_token_hash=$1, password_reset_expires_at=$2 WHERE id=$3', [hashToken(rawToken), expiresAt, user.id]);
      const link = `${this.email.appBaseUrl()}/auth/reset-password?token=${rawToken}`;
      await this.email.send({
        to: normalized, subject: 'Reset your SCCF password',
        text: `Reset your password by opening this link:\n${link}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes. If you didn't request this, you can ignore this email -- your password hasn't been changed.`,
      });
      await this.audit.record({ actorId: user.id, action: 'PASSWORD_RESET_REQUESTED', entityType: 'USER', entityId: user.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    }
    return GENERIC_CHECK_EMAIL;
  }

  async me(userId: string) {
    const result = await this.db.query<{ email: string; first_name: string | null; last_name: string | null; mfa_enabled: boolean; must_change_password: boolean }>(
      'SELECT email, first_name, last_name, mfa_enabled, must_change_password FROM users WHERE id=$1', [userId],
    );
    if (result.rowCount === 0) throw new BadRequestException('USER_NOT_FOUND');
    const roles = await this.db.query<{ code: string }>(
      `SELECT r.code FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [userId],
    );
    const u = result.rows[0];
    return {
      id: userId, email: u.email, firstName: u.first_name, lastName: u.last_name,
      mfaEnabled: u.mfa_enabled, mustChangePassword: u.must_change_password,
      roles: roles.rows.map((r) => r.code),
    };
  }

  async resetPassword(rawToken: string, newPassword: string, ctx: { ip?: string; userAgent?: string }) {
    const errors = passwordPolicyErrors(newPassword);
    if (errors.length) throw new BadRequestException(errors.join(' '));

    const tokenHash = hashToken(rawToken);
    const result = await this.db.query<{ id: string; password_reset_token_hash: string; password_reset_expires_at: string }>(
      `SELECT id, password_reset_token_hash, password_reset_expires_at FROM users WHERE password_reset_token_hash IS NOT NULL`,
    );
    const match = result.rows.find((r) => hashesMatch(r.password_reset_token_hash, tokenHash));
    if (!match || new Date(match.password_reset_expires_at).getTime() < Date.now()) {
      throw new BadRequestException('RESET_TOKEN_INVALID_OR_EXPIRED');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.db.query(
      `UPDATE users SET password_hash=$1, password_reset_token_hash=NULL, password_reset_expires_at=NULL,
         failed_login_count=0, locked_until=NULL, must_change_password=FALSE, updated_at=now() WHERE id=$2`,
      [passwordHash, match.id],
    );
    // A password reset is exactly the moment to assume every existing session might be compromised.
    await this.db.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [match.id]);
    await this.audit.record({ actorId: match.id, action: 'PASSWORD_RESET_COMPLETED', entityType: 'USER', entityId: match.id, ipAddress: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    return { ok: true };
  }
}

function activationPage(ok: boolean, message: string): string {
  const title = ok ? 'Account activated' : 'Activation link problem';
  const color = ok ? '#1F5A2D' : '#8C1F35';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title} - SCCF</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#211D1B">
<h1 style="color:${color}">${title}</h1><p>${message}</p></body></html>`;
}
