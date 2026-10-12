# Sickle Cell Child Care Foundation Platform — Engineering Scaffold

**Status: 7 domains built with a working HTTP API, verified against a
real PostgreSQL database. Synthetic data only. Not production-ready.
The newest piece — donor signup/activation/MFA — is written but not
yet run; see below.**

## What changed most recently

Previously this scaffold had a full service/domain layer but **no
HTTP layer** — no controllers, no request validation, guards defined
but never attached to a route. That's fixed: every module now has
real `@Controller()` classes, DTOs with `class-validator`, and the
`DomainAccessGuard` actually enforced on every route via
`@RequireDomain()`.

More importantly, this was **actually run** — not just written.
Postgres was installed, all 9 migrations were applied in order, the
seed script was run, and 48 unit tests + 16 end-to-end tests
(`supertest` against a live NestJS instance + live Postgres) were
executed and pass. This caught a real bug (`getFundLedgerBalance`
always returned 0 against real data — see `docs/OPEN_ITEMS.md` #30)
that 48 passing mocked unit tests had not caught, because mocks never
run real SQL.

## Donor signup, activation, and auth hardening (this session)

Self-service donor signup (`POST /auth/signup`) with an emailed
activation link, password reset, account lockout after repeated failed
logins, TOTP MFA (`/auth/mfa/*`), and refresh tokens that can actually
be revoked (stored server-side, rotated on every use). Also: helmet
security headers, a locked-down CORS allowlist instead of the previous
wide-open setting, per-route rate limiting on the auth endpoints
specifically, and OpenAPI/Swagger docs at `/api/docs`.

**This code has not been run** — unlike the previous session, which
installed Postgres and ran everything for real, this one was built in
an environment with no network access to npm at all. It was written by
closely cross-referencing the existing codebase's actual method
signatures and conventions rather than assumed, and comes with a new
e2e suite (`test/auth-security.e2e-spec.ts`) to exercise it — but that
suite has never actually executed. Treat it as a careful first draft:
**run `npm install`, the migration, the updated seed step, and
`npm run test:e2e` before relying on any of it.** Full Windows/
PowerShell instructions, including a couple of real gaps found and
fixed along the way (`.env` was never actually being loaded; the seed
script's shell syntax doesn't work in PowerShell), are in
`docs/LOCAL_SETUP_WINDOWS.md`. Details and the one real bug this
process already found (MFA was bypassable via token replay, now fixed)
are in `docs/OPEN_ITEMS.md`.

**Admin accounts:** there's no sign-up for these (correctly -- a public
form that could create one would be a real hole). The first one is
created locally with `node scripts/create-admin.js you@yourdomain.org`,
which prints a one-time password once. Full steps, including setting a
real password afterward, are in `docs/LOCAL_SETUP_WINDOWS.md`.

**Also added since then:** caregiver and provider self-signup
(`/auth/signup/caregiver`, `/auth/signup/provider` -- a provider account
is email-verified but functionally inert until an admin links it to a
verified `providers` row); an admin-invite flow (`/admin/invite` ->
emailed link -> `/auth/invite/accept`) for creating any *other* staff
account without touching the database directly; an admin-unlock
endpoint for clearing a login lockout without a full password reset;
MFA secrets now encrypted at rest (AES-256-GCM); and a minimal but real
frontend -- login, signup, password reset, an admin dashboard, a donor
dashboard -- served at `/portal/*` from this same app, plain HTML/CSS/JS
with no build step. See `docs/LOCAL_SETUP_WINDOWS.md` for the full list
of pages, and `docs/OPEN_ITEMS.md` for what's still rough about it.

## What's built (7 domains)

1. **Identity/RBAC/Audit/Policy** — JWT auth, domain-based RBAC
   enforced by a real guard, append-only audit, PROVISIONAL policy
   tracking for the 11 governance decisions.
2. **Care Graph** — Beneficiary → Case → Need → Intervention.
3. **Provider** — lifecycle + Service delivery records.
4. **Finance** — Fund → Allocation → Commitment → Payment → Ledger →
   Reconciliation, with real transactional atomicity (verified: the
   allocation row and its ledger entries commit or roll back
   together), idempotent payments, fund-restriction enforcement.
5. **Clinical** — isolated from beneficiary identity, with the
   existence-only visibility rule verified end-to-end: a Safeguarding
   Officer can see *that* a clinical link exists but the actual
   clinical description never appears in that response, confirmed by
   asserting on the real HTTP response body, not a mock.
6. **Safeguarding** — unregistered-child support, conflict-of-interest
   register, all verified against a real incident record.
7. **Donor/Sponsorship** — four sponsorship pathways, idempotent
   donation confirmation, and `DonorSafeViewService` — verified end-
   to-end that a real donor's HTTP response never contains the
   sponsored child's actual name, school, or exact birthdate.

## This is now one integrated system

Previously the public marketing website and this backend were two
separate deliverables. They are now wired together as a single running
system:

- `website/public-website/` is the public site (home, about, sickle
  cell information, get-help, programmes, sponsor, **donate**, **blog**,
  impact, stories, resources, contact) — plain HTML/CSS/external JS, no
  build step, using the Foundation's own uploaded photography.
- `backend/src/app.module.ts` now serves **three things from one Nest
  process, on one port**: the website at `/`, the account portal at
  `/portal/*` (unchanged), and the JSON API at its existing routes
  (`/auth/*`, `/admin/*`, `/donor/*`, `/clinical/*`, `/safeguarding/*`,
  `/sponsorships/*`, `/finance/*`). A `ServeStaticModule.exclude` list
  stops the website's static handler from ever shadowing those API/
  portal routes.
- The website's **Sign In** nav link, the donor-account callout on
  `donate.html`, and the sponsorship CTAs now point at `/portal/login.html`
  and `/portal/signup.html` — real links to the live account system, not
  placeholders. Because everything is same-origin once deployed this
  way, no CORS configuration is needed between the two halves.
- `donate.html` carries the brand-coloured payment widget (Mobile Money
  blending Airtel red/M-Pesa green, Paybill/Till, Visa/Mastercard,
  PayPal, Stripe). Every method is a real, working UI shell, but shows
  "(soon)" and submits nothing until real merchant credentials are
  filled into `website/public-website/js/config.js` — no placeholder
  here pretends to be a live payment, per standing instruction.
- The floating "Talk to us" contact widget and social-icon rail are
  present on every page; the chatbot stays **off**
  (`chatbotEnabled: false` in `config.js`) per standing instruction.
- `main.ts`'s security headers (Helmet CSP) were adjusted to allow what
  the website actually needs — Google Fonts and the inline `style="..."`
  attributes used in a few hand-written accents — while keeping
  `script-src 'self'` strict everywhere (every page's JS is external,
  never inline) and leaving the Swagger-only relaxation on `/api/docs`
  untouched.

Run it as one system:

```bash
cp .env.example backend/.env   # then fill in real secrets -- see comments in the file
docker compose -f infra/docker/docker-compose.yml up -d
cd backend
npm install
npm run migrate
npm run seed
npm run start:dev
# -> http://localhost:8000/            (public website)
# -> http://localhost:8000/portal/     (sign in / sign up / dashboards)
# -> http://localhost:8000/api/docs    (API reference)
```

**Important — this has never been executed.** As with the auth/admin
work above, this sandbox has no network access to the npm registry
(`npm install --dry-run` returns 403; `npm install --offline` returns
`ENOTCACHED` — nothing is cached locally either), so none of this
TypeScript, including the `app.module.ts`/`main.ts` changes just made,
has ever been compiled or run. The website's HTML/CSS/JS was written
and can be opened directly in a browser to check it visually, but the
*integration* (serving it from the Nest app, the CSP changes, the
exclude list) is unverified until you run `npm run start:dev` yourself
and check all three surfaces above.

## Running it yourself

On Windows/PowerShell, use `docs/LOCAL_SETUP_WINDOWS.md` instead — a
couple of these steps use Unix shell syntax that doesn't work as-is in
PowerShell (noted inline below).

```bash
cp .env.example .env
docker compose -f infra/docker/docker-compose.yml up -d
cd backend
npm install
npm run migrate
npm run seed              # PowerShell: use the psql command in docs/LOCAL_SETUP_WINDOWS.md instead
npm run start:dev         # API on :8000; docs at :8000/api/docs

# Unit tests (mocked DB)
npm test

# End-to-end tests (real Postgres — needs DATABASE_URL, JWT_ACCESS_SECRET, JWT_REFRESH_SECRET set)
npm run test:e2e
```

## Donation channels are admin-controlled, not hardcoded

The donate page's payment methods (Mobile Money, Paybill/Till, Visa/
Mastercard, PayPal, Stripe, Crypto) are listed in a `donation_channels`
table and shown on the website only if `enabled`. Toggle any of them from
the admin dashboard's "Donation payment channels" section, or directly:

```
GET  /payment-channels              # public -- enabled channels only, no auth
GET  /admin/payment-channels         # admin -- every channel, including disabled
PATCH /admin/payment-channels/:code  # admin -- { "enabled": true | false }
```

Mobile Money and Paybill/Till start enabled; Visa, PayPal, Stripe, and
Crypto start disabled. Stripe in particular should stay off while it
remains unusable in Kenya -- this is exactly the situation the toggle
exists for, so that's a dashboard click, not a deploy.

## Reporting, and in-app notifications

Two additions beyond the original 7 domains:

- **Reporting** (`GET /reporting/*`) -- read-only cross-domain analytics
  (case load, fund balances, donations over time, sponsorship/provider/
  service summaries) for MEL, audit, finance, and foundation-admin roles.
  Gated on its own `REPORTING` data-domain grant, not on CARE/FINANCE/
  DONOR, so a MEL or audit user sees the numbers without being handed
  access to the underlying records they're drawn from.
- **Notifications** (`GET/POST /notifications/*`) -- an in-app feed,
  scoped to each user's own account. A donor is notified when their
  donation is confirmed or their sponsorship is activated; a provider's
  linked user is notified if their verification lapses and their account
  moves to Under Review; an unlocked or newly-linked account is notified
  too. There's no route to create a notification for yourself or anyone
  else -- only other services can do that, from real events.

## Known open items
See `docs/OPEN_ITEMS.md`. Structural gaps are closed, and every
engineering-side item from the last review has been built this session
(Care Plan versioning, the duplicate-sponsorship guard, donor-safe-view
caching, provider-verification expiry, reporting, notifications). What
remains is not engineering's to resolve: a Kiswahili translation review
(needs a native speaker) and the constant -- **the 11 governance
decisions**, which need Foundation/legal/clinical/finance sign-off.

**None of this session's backend code has been executed** (see above --
still no npm registry access in this sandbox). Run `npm install`, apply
migrations 014 and 015, reseed, then `npm run build && npm run test:e2e`
before relying on any of it.
