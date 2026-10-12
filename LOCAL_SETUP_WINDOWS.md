# Running the backend locally on Windows (PowerShell)

This covers getting the API running on your own machine with a local
PostgreSQL database, using PowerShell to drive it and either Visual Studio
or VS Code to edit it.

A note on editors: this is a plain Node.js/NestJS project (not a .NET
project), so **VS Code** is the conventional tool for it and gets you
integrated terminal + debugging with zero extra setup. Full **Visual
Studio** (2022+) can also open it directly via *File -> Open -> Folder*
if that's what you have installed and prefer -- the Node.js development
workload (installed via the Visual Studio Installer) adds IntelliSense
for it, but you'll still run every command below from PowerShell either
way, since Visual Studio doesn't drive npm scripts itself.

## 1. Install prerequisites

```powershell
# Node.js LTS and PostgreSQL. If these winget package IDs have changed,
# `winget search nodejs` / `winget search postgresql` will show the current ones.
winget install OpenJS.NodeJS.LTS
winget install PostgreSQL.PostgreSQL
```

Restart PowerShell after installing so both tools are on PATH. Confirm with:

```powershell
node -v
psql --version
```

## 2. Create the local database

Using the `postgres` superuser the installer created (it will prompt for
the password you set during install):

```powershell
psql -U postgres -c "CREATE ROLE sccf_app WITH LOGIN PASSWORD 'changeme';"
psql -U postgres -c "CREATE DATABASE sccf_dev OWNER sccf_app;"
```

Change `changeme` to a real local password and use the same value in `.env` below.

## 3. Configure the project

```powershell
cd backend
Copy-Item ..\.env.example .env
```

Generate three **different** random secrets and paste them into `.env` as
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `MFA_ENCRYPTION_KEY`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Update `DATABASE_URL` in `.env` to match the role/password/database from step 2,
e.g. `postgresql://sccf_app:changeme@localhost:5432/sccf_dev`.

Leave `SMTP_HOST` blank for now -- see step 6.

## 4. Install dependencies, migrate, seed

```powershell
npm install
npm run migrate
```

The `seed` npm script is written for a Unix shell (`psql "$DATABASE_URL" ...`),
which isn't valid PowerShell syntax (PowerShell needs `$env:DATABASE_URL`), so
run the equivalent directly instead of `npm run seed`:

```powershell
$env:DATABASE_URL = "postgresql://sccf_app:changeme@localhost:5432/sccf_dev"
psql $env:DATABASE_URL -f database/seeds/seed.sql
```

(If you have Git Bash or WSL installed, `npm run seed` works as-is there instead.)

## 5. Create the first admin account

There is no sign-up form for admin accounts -- deliberately, since a
public form that could create one would be a serious hole. The very
first `SYSTEM_ADMIN` account is created once, locally, by whoever
already has database access:

```powershell
node scripts/create-admin.js admin@yourdomain.org
```

This prints a generated one-time password **once** -- copy it
immediately, it is not stored anywhere in recoverable form. Log in with
it, then call `POST /auth/forgot-password` with the same email to set
a real password you actually chose (the login response includes
`"must_change_password": true` as a reminder until you do). From then
on this account can be used to build out an admin-invite flow for
everyone else -- that doesn't exist yet; see `docs/OPEN_ITEMS.md`.

## 6. Run it

```powershell
npm run start:dev
```

You should see:

```
SCCF API listening on :8000 [development]
API docs: http://localhost:8000/api/docs
```

Open that docs URL in a browser to see every route (Swagger/OpenAPI) and try
requests directly from there.

A small frontend is also served from the same app, at `http://localhost:8000/portal/`:

- `login.html` -- shared login for every role, including the MFA step
- `signup.html` -- donor / caregiver / provider self-signup, with tabs
- `forgot-password.html`, `reset-password.html` -- password reset
- `accept-invite.html` -- where an admin-invited user sets their first password
- `donor-dashboard.html` -- basic account view + MFA setup (any non-admin role lands here)
- `admin-dashboard.html` -- invite a user, unlock accounts, approve pending provider links (`SYSTEM_ADMIN`/`FOUNDATION_ADMIN` only)

It's deliberately plain -- vanilla HTML/CSS/JS, no build step, no framework --
so it runs immediately with zero extra tooling. Treat it as a working
reference implementation of the API, not a finished product design.

## 7. Test signup -> activation -> login without setting up email first

With `SMTP_HOST` blank in `.env`, the server prints emails to its own
PowerShell window instead of sending them. To try the whole flow:

1. Open `http://localhost:8000/portal/signup.html` and create a donor account
   (or use the Swagger UI / any HTTP client to call `POST /auth/signup`
   directly -- same thing).
2. Look at the PowerShell window running `npm run start:dev` -- it prints
   the full email, including the activation link
   (`http://localhost:8000/auth/activate?token=...`).
3. Open that link in a browser. You should see a plain "Account activated" page.
4. Go to `http://localhost:8000/portal/login.html` and log in with the same
   email/password -- you should land on the donor dashboard.

When you're ready to send real email, fill in `SMTP_HOST`/`SMTP_PORT`/
`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` in `.env` (any standard SMTP provider
works -- Gmail with an app password, SendGrid, Mailgun, etc.) and restart
the server.

## 8. Running the tests

Unit tests don't need a database:

```powershell
npm test
```

The end-to-end tests do -- they run real queries against the `sccf_dev`
database set up above (make sure migrations + seed from steps 4 have been run):

```powershell
npm run test:e2e
```

## Troubleshooting

- **`psql` not found** -- the PostgreSQL installer sometimes doesn't add
  `psql` to PATH. It's typically under
  `C:\Program Files\PostgreSQL\<version>\bin`; add that folder to PATH or
  call `psql` with the full path.
- **`ECONNREFUSED` connecting to Postgres** -- the PostgreSQL Windows
  service may not be running: check with `Get-Service postgresql*` and
  `Start-Service` if it's stopped.
- **Port 8000 already in use** -- change `PORT` in `.env`.
