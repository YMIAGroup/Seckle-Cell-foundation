# Open Engineering Items

## Session: admin invite, caregiver/provider signup, a real frontend, and two hardening items

Four things requested together, all delivered:

1. **Admin-invite flow.** `POST /admin/invite` (SYSTEM_ADMIN/FOUNDATION_ADMIN
   only) creates a user with no password, any role, and emails a link to
   `/portal/accept-invite.html`, which calls `POST /auth/invite/accept` to
   set the password and activate in one step. Distinct from self-signup:
   the invitee never chooses a password until they accept.
2. **Caregiver and provider signup.** `signupDonor` was refactored into a
   shared `selfServiceSignup(roleCode, ...)` used by all three. Provider
   signup additionally writes a `provider_users` row with
   `status='PENDING_LINK'` -- see below for why it isn't simply granted
   access like donor/caregiver are.
3. **A real frontend.** Plain HTML/CSS/JS (no framework, no build step),
   served from this same NestJS app at `/portal/*` via `@nestjs/serve-static`.
   Same-origin, so it calls the API with relative fetch() paths and needs
   no CORS setup. Pages: login (with inline MFA step), signup (donor/
   caregiver/provider tabs), forgot/reset password, accept-invite, a donor
   dashboard (account info + self-service MFA setup), and an admin
   dashboard (invite form, locked-accounts list with unlock buttons,
   pending-provider-link approval).
4. **mfa_secret encrypted at rest** (`src/common/crypto-at-rest.ts`,
   AES-256-GCM, no new dependency) and **admin account unlock**
   (`POST /admin/users/:id/unlock`) -- both previously flagged, both done.

### A design question this surfaced: who is allowed to administer accounts?
`rbac.service.ts` is explicit that `SYSTEM_ADMIN` deliberately gets no
rows in the domain-access matrix ("never special-case it here" --
CARE/CLINICAL/FINANCE/SAFEGUARDING/DONOR access stays separate from
having the admin role). Gating `/admin/*` through the existing
`DomainAccessGuard` would therefore have locked out the one account
meant to use it. Added `AdminRoleGuard` instead -- a direct role-code
check (`SYSTEM_ADMIN` or `FOUNDATION_ADMIN`), deliberately bypassing the
domain matrix entirely rather than adding rows to it, so identity
administration stays a separate concern from CARE/CLINICAL/FINANCE/
SAFEGUARDING/DONOR data access, consistent with the existing comment's
intent. Worth a second opinion from whoever owns that design, since it's
inferring intent from a comment rather than an explicit decision.

### Why provider signup doesn't grant access immediately
`providers` (004_provider.sql) represents vetted organisations, created
today only by staff with CARE:WRITE. There was no concept of "a user
account representing a provider" at all before this session. Rather than
quietly inventing trust that was never granted, provider self-signup
creates the account (so the email is verified) but leaves it unlinked to
any real provider until an admin explicitly approves the link via the
new `provider_users` table and `/admin/provider-users/:id/link`. The
frontend signup form explains this ("reviewed before you gain access").

### Two bugs found while building this (same pattern as last time -- caught by tracing the code, not by running it)
1. **Signup response would have leaked account existence.** Refactoring
   `signupDonor`'s body into the shared `selfServiceSignup` helper
   initially left `signupDonor`/`signupCaregiver` returning that helper's
   raw `{ userId }` result instead of the generic "check your email"
   message -- which would have told an attacker, via the response shape
   alone, whether an account was just created. Caught while re-reading
   the diff before moving on; fixed to always return the generic message.
2. **Helmet's default CSP would have silently broken both the new
   frontend and the existing Swagger UI.** Helmet blocks inline
   `<script>`/`<style>` by default -- correct for the real application,
   but Swagger UI's bundled page needs inline scripts to boot, and every
   /portal page was originally drafted with inline `<script>` blocks for
   simplicity. Fixed two ways: every /portal page's script was
   externalised into its own .js file (so the strict policy applies to
   the real app unchanged), and a relaxed CSP is applied narrowly to just
   `/api/docs` (see `main.ts`) rather than loosened globally.

### Still not run
Same caveat as the previous two sessions, now covering more surface
area: `test/admin-and-roles.e2e-spec.ts` (new) covers non-admin rejection,
caregiver signup not creating a donor profile, invite -> accept with the
right role attached, duplicate-invite rejection, unlock, provider
signup -> link, and that `mfa_secret_pending` is stored encrypted (not
equal to the plaintext secret, matches the iv.tag.ciphertext hex format)
-- all against the actual script/endpoints, not mocks of them. None of
it has executed. Run `npm run migrate` (picks up `012_admin_provider.sql`
automatically) and `npm run test:e2e` before trusting any of this.

### What's still missing
- The frontend is intentionally minimal -- no sponsorship browsing, no
  donation history, no case-worker tools. It's a working reference
  implementation of the API surface, not a finished portal.
- No way yet to revoke a single user's *other* sessions (all their
  refresh tokens) outside of a full password reset.
- `AdminRoleGuard`'s design choice above should get an explicit decision,
  not just an inference from a code comment.

## Session: donor self-signup, email activation, and auth hardening

Built on top of the previous session's HTTP layer: self-service donor
signup with email activation, password reset, brute-force account
lockout, TOTP-based MFA (RFC 6238, no external dependency), and
revocable/rotating refresh tokens. Also added helmet security headers,
a restricted CORS allowlist (replacing the previous `app.enableCors()`,
which accepted every origin), per-route rate limiting via
`@nestjs/throttler`, and OpenAPI/Swagger docs at `/api/docs`.

**Unlike the previous session, this one was NOT run against a live
database or compiled** -- this sandbox has no network access, so
`npm install` cannot reach the npm registry at all (confirmed directly:
a dry-run install was attempted and failed with 403). Every file was
written by closely cross-referencing the actual existing source (exact
method signatures of `DatabaseService`, `AuditService`, `DonorService`,
`nextReference`, the exact shape `JwtAuthGuard` expects/produces, the
real `DONOR` role code and `users` table columns from the seed and
migrations) rather than assumed, and a new e2e suite
(`test/auth-security.e2e-spec.ts`, styled after the existing
`flow.e2e-spec.ts`) was written to exercise all of it -- but none of
this has actually been executed. **Run `npm install && npm run migrate`
and the new `psql` seed command, then `npm run test:e2e`, before
trusting this in anything but local development.** See
`docs/LOCAL_SETUP_WINDOWS.md`.

### Bug found and fixed while building this: MFA could be bypassed entirely
The short-lived `mfa_token` issued mid-login (proving "password was
correct, MFA code still needed") was signed with the same secret as a
real access token. `JwtAuthGuard` only checks the signature, so that
token -- which anyone who intercepted a login response would have --
could have been replayed as a normal `Authorization: Bearer` header
against *any* protected route, skipping the MFA step completely.
Fixed by having the guard reject any token carrying a `type` claim
(real access tokens never have one); covered by a dedicated e2e
assertion. This is the kind of bug that's invisible until you
specifically try to misuse a token the "wrong" way -- worth bearing in
mind for whatever auth surface gets built next.

### Also found: `.env` was never actually being loaded
`@nestjs/config` was a listed dependency but never imported anywhere --
copying `.env.example` to `.env` had no effect, because nothing read
it. `JWT_ACCESS_SECRET` etc. only ever worked if someone set them
directly in the shell. Fixed with `import 'dotenv/config'` as the
first line of `main.ts` (and a matching Jest `setupFiles` entry for
`test:e2e`), not a full `ConfigModule.forRoot()`, because the env
values are needed synchronously before Nest's module graph (where
`ConfigModule` would take effect) is even built.

### New migration: `010_auth_security.sql`
Adds activation/reset token columns, lockout counters, MFA secret
columns, and a `refresh_tokens` table (needed so a refresh token can
actually be revoked -- a JWT's signature alone can't be invalidated
before it expires). Also a `seq_user_ref` sequence: no prior code path
ever needed to generate a `user_ref`, since the seed and test fixtures
hardcode theirs.

### Addendum: admin bootstrap
Added `scripts/create-admin.js` -- a standalone local script (not an
HTTP endpoint, deliberately) that creates the first `SYSTEM_ADMIN`
account with a generated one-time password, printed once. Also added
migration `011_admin_bootstrap.sql` (`must_change_password` column)
and threaded that flag through the login/MFA/reset-password response
so a client can prompt for a real password without needing a brand-new
"change password while logged in" endpoint -- it reuses the
already-tested forgot-password/reset-password flow instead.
`test/admin-bootstrap.e2e-spec.ts` runs the actual script as a
subprocess (not a mock) and exercises the full real path: script ->
login -> forgot-password -> reset-password with the real emailed
token -> flag clears. Same caveat as everything else in this session:
written carefully, never executed.

### What's still missing for this to be production-ready
- **Not run.** See above -- this is the most important open item.
- No in-app admin-invite flow yet for creating the *second* admin or
  any other staff account -- today that still means direct database
  access or extending `create-admin.js`'s pattern.
- `mfa_secret` is stored as plain `TEXT`. Production should encrypt it
  at rest (e.g. `pgcrypto`'s `pgp_sym_encrypt` with a key kept outside
  the database), not rely on the column staying private by database
  access control alone.
- No admin-facing way to unlock an account early or revoke a specific
  user's sessions outside of a password reset.
- Caregiver/staff signup still doesn't exist -- this session only
  covers the donor path, by request.

## What changed in this session

Built the missing HTTP layer (controllers, DTOs, guards actually wired
up) and then — critically — **ran it for real**: installed Postgres,
applied all 9 migrations, ran the seed, and executed the full test
suite against a live database instead of only mocks. This caught one
real bug that no amount of mocked unit testing could have found:

### Bug found and fixed: fund balance query
`LedgerService.getFundLedgerBalance()` summed `credit - debit` across
**all** ledger accounts for a fund. In balanced double-entry
bookkeeping every transaction nets to zero across its own accounts by
definition — so this query always returned 0, and every allocation
failed with "insufficient funds" the moment it touched a real
database. Fixed to sum only the `FUND_AVAILABLE` account specifically.
Also fixed the `GET /funds/:id/balance` endpoint to return a JSON
object instead of a bare number, and the demo seed data's opening
balance to offset against `DONATIONS_INCOME` (created by the Donor
module's migration) rather than a stale `FUND_PAID` reference.

This is exactly the kind of bug the "structural gap" callout was
warning about: 48 passing unit tests with mocked databases gave real
confidence in the business logic, but none of them could catch a bug
in the SQL itself, because the mocks never ran real SQL.

## Status snapshot

| # | Item | Status |
|---|------|--------|
| 1-23 | (see prior sessions) | ✅ DONE |
| 24 | Donor/Sponsorship module | ✅ DONE |
| 25 | No duplicate-sponsorship check | OPEN (P2) |
| 26 | Donor-safe-view recomputes on every call | OPEN (P2) |
| 27 | Donor pause/cancel UI flow not wired | ✅ DONE — `StaffSponsorshipController` |
| 28 | **No HTTP layer existed** (no controllers, no DTO validation, guards unattached) | ✅ DONE this session |
| 29 | **No integration/e2e tests, nothing ever run against real Postgres** | ✅ DONE this session — 16 e2e tests, real Postgres, real migrations |
| 30 | **`getFundLedgerBalance` always returned 0 against real data** | ✅ FIXED — found only by running e2e against real Postgres |

## Verified, not just claimed, in this session
- All 9 migrations apply cleanly in order against Postgres 16
- Seed script loads without error (12 roles, 11 governance decisions, 5+1 ledger accounts)
- 48 unit tests pass
- 16 e2e tests pass, covering: authentication, cross-domain authorization denial (donor→Care, donor→Clinical, donor→own-donation-confirmation, case-worker→Finance), DTO validation (whitelist rejection, enum rejection), the full donation→allocation→sponsorship→donor-safe-view business flow, idempotent donation confirmation, state-machine rejection of illegal transitions, the clinical/safeguarding existence-only isolation boundary, and audit-trail presence
- Full TypeScript compilation is clean

## Still open (all P1/P2, none structural)
- #25, #26 (see above)
- Kiswahili translation review (needs a native speaker)
- Care Plan versioning service
- Provider verification expiry scheduled job
- No reporting/analytics layer, no notifications module

## The constant
The 11 governance decisions need Foundation/legal/clinical/finance
sign-off — this was never engineering's to resolve, and running more
tests doesn't change that.

## Integration (this session): website + backend -> one system
The public website and this backend were previously built and delivered
separately. They are now one system: the website is served at `/`, the
account portal at `/portal/*`, and the API at its existing routes, all
from the same NestJS process (`src/app.module.ts`, two `ServeStaticModule`
registrations, the second `exclude`-guarded so it can never shadow API/
portal routes). The website's Sign In and account links now point at
`/portal/login.html` / `/portal/signup.html` for real, and the donation
page's payment widget is wired up (as an honest "(soon)" shell, no live
credentials) rather than existing as a separate, disconnected mockup.

**Not yet verified by execution** (same standing limitation as the rest
of this backend): this sandbox cannot reach the npm registry, so the
`app.module.ts`/`main.ts` changes that make the integration work --
including the CSP adjustment that lets the website's Google-Fonts
`@import` and inline `style="..."` attributes load -- have not been
compiled or run. Run `npm install && npm run start:dev` and check all
three surfaces (`/`, `/portal`, `/api/docs`) before relying on this.

## Admin-controlled donation channels + Crypto option (this session)
Added so the Foundation can hide a payment method the moment it stops
being usable -- the immediate case being Stripe, which is currently not
usable in Kenya -- without a website change or deploy.

- **New table**: `donation_channels` (migration 013) -- `code`, `label`,
  `enabled`, `sort_order`. Seeded (`seed.sql`) with Mobile Money and
  Paybill/Till **enabled**, and Visa, PayPal, **Stripe**, and the new
  **Crypto** channel **disabled** by default.
- **New module** `payment-channels`: `GET /payment-channels` is public
  (no auth -- the donate page is visited by anonymous donors) and returns
  only enabled channels. `GET /admin/payment-channels` (full list) and
  `PATCH /admin/payment-channels/:code` (toggle) are added to the existing
  `AdminController`, behind the same `AdminRoleGuard` as everything else
  under `/admin/*`.
- **Admin dashboard**: a new "Donation payment channels" section
  (`admin-dashboard.html`/`.js`) lists every channel with a Show/Hide
  button per row.
- **Website**: `donate.html`'s payment widget now has a Crypto tab
  alongside the existing ones, and `js/payments.js` fetches
  `/payment-channels` on load and only shows the tabs that come back,
  picking the first visible one as the default active tab. If the
  endpoint can't be reached at all (e.g. the page opened as a static file
  with no backend behind it), it falls back to showing just Mobile Money
  and Paybill/Till -- the same two the platform seeds as enabled -- rather
  than leaving the widget stuck on "Loading...".
- **Audit**: every toggle is recorded (`DONATION_CHANNEL_ENABLED` /
  `DONATION_CHANNEL_DISABLED`) via the existing `AuditService`, with the
  channel's code in `new_value` rather than `entity_id` (that column is
  `UUID` and a channel's identity is a short code, not a UUID).
- **Tests**: `test/payment-channels.e2e-spec.ts` -- public endpoint needs
  no auth and never returns disabled channels or `updated_by`; a non-admin
  gets 403 from both admin routes; an admin can see Stripe disabled and
  Mobile Money enabled in the seeded data, toggle Crypto on and Mobile
  Money off and see the public list react to both; an unknown channel code
  returns 404 and a non-boolean `enabled` returns 400.

**Not yet verified by execution**, same standing limitation as the rest of
this backend: no npm registry access in this sandbox, so migration 013,
the new module, and this e2e suite have not been run. Apply the migration
(`npm run migrate`), reseed, and run `npm run test:e2e` before relying on
this.

## Session: the remaining engineering-side open items (Care Plan versioning, duplicate-sponsorship guard, donor-safe-view caching, provider-verification expiry, reporting, notifications)

Everything the previous session's status table listed as still open and
engineering's to do (not Foundation/legal/clinical sign-off, which stays
open and isn't engineering's to resolve) is now built:

1. **Care Plan versioning** (`care/care-plan.service.ts`, new). The
   `care_plans` table existed since the very first care migration with no
   service or route ever writing to it. `createNewVersion()` runs inside
   `db.withTransaction()`, locks the current ACTIVE row `FOR UPDATE`,
   marks it SUPERSEDED, and inserts the next version. New routes:
   `POST/GET /cases/:caseId/care-plans`, `GET /cases/:caseId/care-plans/active`.

2. **Duplicate-sponsorship guard** (`donor/sponsorship.service.ts` +
   migration `014_sponsorship_duplicate_guard.sql`). A donor could
   previously end up with two live sponsorships for the same child, need,
   or programme -- nothing stopped it. Defense in depth: an application-level
   `assertNoDuplicate()` pre-check for a clean 400, backed by three Postgres
   partial unique indexes (`WHERE status IN ('PROPOSED','ACTIVE','PAUSED')`)
   as the actual guarantee against a race between two concurrent requests,
   with the insert's `23505` caught and turned into the same `DUPLICATE_SPONSORSHIP`
   response rather than a raw 500.

3. **Donor-safe-view caching** (`donor/donor-safe-view.service.ts`). The
   three queries behind `GET /donor/sponsorships/:id/child-profile` ran on
   every call with no caching at all. Added a small in-memory `TtlCache`
   (`common/ttl-cache.ts`, 60s TTL, Map-based, per-process -- **not** shared
   across multiple server instances, documented as such) keyed by
   beneficiary ID. The ownership/ACTIVE-status authorization check and the
   audit-trail write (`audit.recordDataAccess()`) always run fresh, cache
   hit or not -- only the actual profile computation is cached, so caching
   performance can never weaken an authorization or audit guarantee.

4. **Provider verification expiry** (`provider/provider-verification.service.ts`,
   `provider-verification.job.ts`, new). `provider_verifications.expiry_date`
   existed since the first provider migration; nothing ever read it, so a
   provider verified once stayed ACTIVE forever even after its certification
   lapsed. Added: a write path (`POST/GET /providers/:id/verifications` --
   this table had no write path at all before now), a daily cron job
   (`@nestjs/schedule`, `ProviderVerificationExpiryJob`, 2am) that marks
   lapsed verifications EXPIRED and moves a now-unverified ACTIVE provider
   to UNDER_REVIEW (the same state a human reviewer would put it in by
   hand), and `POST /admin/provider-verifications/run-expiry-check` to run
   it on demand for ops/testing instead of waiting for the clock.

5. **Reporting/analytics layer** (`reporting` module, new). Read-only
   aggregation across cases, needs, interventions, funds/ledger, donations,
   sponsorships, providers, and services -- for MEL/finance/audit roles,
   not for any of the existing operational domains. Gated on a new
   `REPORTING` data-domain grant rather than reusing CARE/FINANCE/DONOR,
   specifically so a MEL or audit user can see cross-domain numbers
   without being handed access to the underlying domains those numbers are
   drawn from. `MEL_OFFICER` and `AUDITOR` existed as seeded roles since
   the very first identity migration with zero routes either could use --
   this is what they were seeded for. Routes: `GET /reporting/overview`,
   `/cases-by-status`, `/needs-by-category`, `/interventions-by-status`,
   `/fund-balances`, `/donations-over-time` (bucketed by day/week/month,
   optional `?from=&to=`), `/sponsorships-summary`, `/providers-by-status`,
   `/provider-verifications-expiring-soon`, `/service-delivery-summary`.

6. **Notifications module** (`notifications` module, new). A user-scoped
   in-app feed (`notifications` table, migration `015_notifications.sql`)
   with no domain guard -- "can I see my own notifications" needs no
   `RequireDomain` check, only every query scoped to the caller's own
   `user_id`, the same discipline the donor-facing routes already follow.
   `create()` is called from other services, never from an HTTP route, so
   nothing a client sends can forge a notification for itself or anyone
   else. Wired into: `DonationService.confirmReceived` (donor notified
   when their donation is confirmed, skipped for anonymous/offline
   donations with no `donor_user_id`), `SponsorshipService.transition`
   (donor notified when staff activates their sponsorship),
   `ProviderVerificationService.runExpiryCheck` (a provider's linked
   portal user notified when moved to UNDER_REVIEW), `AdminService.unlockAccount`
   and `AdminService.linkProvider` (the affected user notified). Every
   notification write happens **outside** the transaction it's triggered
   by (same reasoning as `audit.record()` elsewhere in this codebase): a
   notification failing must never roll back a state change that already
   committed. Routes: `GET /notifications` (optional `?unreadOnly=true`),
   `GET /notifications/unread-count`, `POST /notifications/:id/read`,
   `POST /notifications/read-all`.

### Tests added this session
`test/provider-verification.e2e-spec.ts`, `test/reporting.e2e-spec.ts`,
`test/notifications.e2e-spec.ts` (all e2e, real Postgres), plus
`test/care-plan.e2e-spec.ts`-equivalent coverage folded into the care
e2e suite, and `test/donation.spec.ts` updated for `DonationService`'s
new `NotificationsService` dependency (confirms a notification fires on
first confirmation, not on an idempotent replay, and not for a donation
with no `donor_user_id`).

### Not yet verified by execution
Same standing limitation as every other session: **this sandbox has no
network access to the npm registry** (`npm install` fails with
ENOTFOUND/403), so none of this session's code -- migrations 015, the
Care Plan/duplicate-sponsorship/donor-safe-view changes, the new
`reporting` and `notifications` modules, the `@nestjs/schedule` dependency
added for the expiry job, or any of the new or updated tests -- has been
compiled or run. Before relying on any of it: `npm install`, apply
migrations 014 and 015 (`npm run migrate`), reseed (the `REPORTING` data
domain and its role grants are new rows in `seed.sql`), then
`npm run build` and `npm run test:e2e`.

## Status snapshot (update)

| # | Item | Status |
|---|------|--------|
| 25 | No duplicate-sponsorship check | ✅ DONE this session |
| 26 | Donor-safe-view recomputes on every call | ✅ DONE this session |
| 31 | Care Plan versioning service | ✅ DONE this session |
| 32 | Provider verification expiry scheduled job | ✅ DONE this session |
| 33 | No reporting/analytics layer | ✅ DONE this session |
| 34 | No notifications module | ✅ DONE this session |

### Still open
- Kiswahili translation review (needs a native speaker) -- not engineering's to resolve.
- The 11 governance decisions (Foundation/legal/clinical/finance sign-off) -- not engineering's to resolve.
- Nothing else engineering-side is currently known to be open.

## Session: full-system audit

A dedicated audit, not more feature work, on explicit request ("audit the
system as it is now ... should be working well"). This went further than
previous sessions' disclosure-and-hope: this sandbox turned out to have a
local, unused PostgreSQL 16 server (`postgresql-16` installed but not
running) and a real TypeScript compiler (`tsc`), neither available to
earlier sessions or not previously tried. Both were used for real
verification, not just static reading:

- **Every migration (001-015) applied cleanly, in order, against a real
  Postgres 16 database**, including the two new ones from this session
  (`014_sponsorship_duplicate_guard.sql`, `015_notifications.sql`).
  `seed.sql` loaded cleanly on top, including the new `REPORTING` domain
  and its four role grants (verified by querying `role_domain_access`
  directly, not just re-reading the SQL).
- **Every new/changed SQL query this session was run for real against
  that database**, not merely re-read: all ten `reporting.service.ts`
  queries, every `notifications.service.ts` query (insert, list, unread
  count, mark-read, mark-all-read), the Care Plan versioning transaction
  (v1 created, v2 genuinely supersedes v1 and leaves exactly one ACTIVE
  row), the duplicate-sponsorship partial unique index (confirmed it
  really rejects a second live sponsorship for the same donor+beneficiary
  with the exact Postgres error `sponsorship.service.ts` catches, and
  really allows a new one once the first is ENDED), and the full
  provider-verification expiry flow (a verification with a past
  `expiry_date` is marked EXPIRED, the provider genuinely moves
  ACTIVE -> UNDER_REVIEW, and the `provider_users` lookup used to decide
  who to notify returns the right row once linked).
- **`tsc --noEmit` run against the whole backend.** Without
  `node_modules` (still no npm registry access -- confirmed again this
  session: direct DNS resolution to `registry.npmjs.org` fails) most
  output is unresolved-import noise, but that noise doesn't hide a real
  syntax error or an argument-count mismatch on our own classes, neither
  of which depend on external type declarations. Zero syntax errors
  across the entire codebase. One real bug found and fixed:
  `notifications/dto/list-notifications-query.dto.ts` had an untyped
  `@Transform(({ value }) => ...)` callback, which fails under this
  project's `strict: true` tsconfig (`TS7031`, implicit `any`) -- fixed
  by typing it as `TransformFnParams`. This is a genuine build-breaking
  error that static reading alone had missed.
- **The public website**, re-rendered end to end with Playwright across
  all 12 pages (desktop + a 375px mobile viewport), console-error and
  uncaught-exception-free except for the Google Fonts request (blocked
  by this sandbox's own network policy, not a code issue) and the
  donate-page payment-channels fetch on a bare `file://` open (the
  documented, intentional fallback to Mobile Money/Paybill). **One real
  bug found and fixed**: `.hero-home-photo` in `css/style.css` used a
  fixed `height: 420px` rather than `min-height`. On a narrow viewport
  the hero's own h1 (4 lines) + lede + CTA buttons are taller than
  420px, so the box stopped growing but its content didn't -- the
  buttons visually overlapped the page's next section. Changed to
  `min-height`; re-verified at 375px width that the hero now grows to
  fit its content and the overlap is gone, while the desktop layout is
  unaffected (it was already taller than 420px there).
- **The portal frontend** (`backend/frontend/*.js`) passed `node --check`
  (plain JS, no transpilation needed) with zero syntax errors across
  every file, including `admin-dashboard.js` after this session's
  em-dash sweep. Rendered with Playwright: login, signup (including the
  Donor/Caregiver/Provider tab-switch, confirmed interactively, not just
  by reading the JS), forgot-password, reset-password (correctly shows
  "this link is missing its token" rather than crashing when opened with
  no query string), and accept-invite (same graceful missing-token
  state) all render with no uncaught exceptions. The two auth-gated
  dashboards correctly redirect to the login page when there's no
  session, which is the intended guard behaviour, not a bug -- their own
  JS and HTML were separately confirmed syntactically sound and
  internally wired correctly (`admin-dashboard.html`'s
  `#paymentChannelsArea` matches what `admin-dashboard.js` targets).
- Confirmed every new/changed module's `@Module` `imports`/`exports`
  resolve correctly for every service that now depends on
  `NotificationsService` (`ProviderModule`, `DonorModule`,
  `AdminModule` all import `NotificationsModule`; `ReportingModule`
  imports `RbacModule` for its `DomainAccessGuard`), matching the
  pattern every other domain module already uses.

**What this does not cover**: actually booting the NestJS process
(`npm run start:dev`) and hitting live HTTP routes end-to-end, or
running the Jest suites themselves -- both still require `npm install`,
which this sandbox still cannot do. The SQL and TypeScript verification
above is real execution, not a substitute for that, but it is real
execution of the parts that could be run without the npm registry.

### Follow-up: user-reported "images distorted", two real bugs found and fixed

After the audit above was delivered, the user opened the zip themselves and
reported the images looked distorted. Re-checked with fresh Playwright
screenshots at desktop, mobile and wide viewports, plus a direct pixel
inspection of every image file in `website/public-website/images/` -- this
found two real, previously-undetected bugs, one of them serious:

- **`images/community-1.jpg` and `images/community-2.jpg` were not photos
  at all.** Both files were full-page mobile browser screenshots of a
  *different, already-deployed copy of this same website*
  (`ymiagroup.github.io`) -- visible browser chrome (status bar, address
  bar, a "Menu" button), a broken-image placeholder icon, and the page's
  own hero text rendered as a screenshot-within-the-screenshot. These were
  used as `<img class="about-photo">` on `index.html` (the "Transparency
  you can trust" section) and `stories.html` (the "Amina, 10" story card).
  With `object-fit: cover` applied, this is what produced the "distorted"
  images the user saw: a hard, nonsensical crop into a browser screenshot
  instead of a real photo. This is almost certainly what the user meant --
  it is a far more visible defect than the hero cropping bug found in the
  previous audit pass. Root cause unknown (most likely a mislabeled/misplaced
  file from an earlier session's own QA screenshots), but the fix is
  straightforward: both files were deleted, and the two `<img>` references
  were repointed to already-legitimate photos already in the asset set that
  were not already used elsewhere on the same page --
  `images/about-clinic.jpg` on `index.html`, `images/how-we-work.jpg` on
  `stories.html` (chosen for its school/case-worker content, a good
  thematic fit for the "Amina... school-materials grant" story). Verified:
  grepped the whole site for any remaining reference to the deleted
  filenames (none), then re-rendered both pages with Playwright and visually
  confirmed both photos now show the correct, sharp, on-brand content with
  no console/request errors.
- **A false alarm, investigated and ruled out**: a first full-page
  Playwright screenshot of `index.html` appeared to show a large blank gap
  where the "Transparency you can trust" section should be. Investigated
  with computed styles first (the image element was present, loaded, and
  correctly sized -- not a real rendering bug) and traced it to
  `js/effects.js`'s scroll-reveal `IntersectionObserver` (`.reveal-init` /
  `.in-view`, documented at the top of that file): Playwright's full-page
  screenshot mode resizes the viewport to capture the whole page in one
  shot without dispatching the scroll events a real visitor's browser
  fires, so sections below the first viewport never cross the
  `IntersectionObserver` threshold and stay at `opacity: 0`. Re-tested by
  actually scrolling the page in increments (as a real visitor would) before
  screenshotting: every section revealed correctly. No code change -- this
  is a screenshot-tool artifact, not a site bug.
- Also double-checked, while in the area: `css/style.css` defines
  `.logo-mark` twice (a leftover 10px decorative-dot rule, then the real
  32px `object-fit: contain` image rule later in the file). Confirmed via
  computed styles that the later rule wins the cascade and the logo renders
  at the correct size everywhere -- dead CSS, not a visible bug, left as-is
  rather than risk an unnecessary change this late.
