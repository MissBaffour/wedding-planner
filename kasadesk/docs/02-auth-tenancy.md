# KasaDesk — Step 2: Auth, Multi-tenancy, Trial and Plan Enforcement

## What was built

| Area | Where |
|---|---|
| Signup (user + business + owner + 14-day Growth trial + default hours), login, refresh rotation, logout, switch business, password reset | `apps/server/src/modules/auth/` |
| Request guard: token → active membership → role → subscription access | `apps/server/src/platform/http/guard.ts` |
| Tenant transactions (`SET LOCAL app.business_id`) and a startup check that refuses RLS-bypassing roles | `apps/server/src/platform/db/index.ts` |
| Business profile, settings (routing, SLA, greeting, language), opening hours, members, invitations, audit log | `apps/server/src/modules/tenancy/` |
| Subscription state machine (pure), plan selection with seat check, worker sweep (transitions, reminders, cleanup) | `apps/server/src/modules/billing/` |
| AES-256-GCM keyring for secrets at rest (used for channel tokens from step 3) | `apps/server/src/platform/crypto.ts` |
| Ghana phone normalization, network hint, UUIDv7 | `packages/shared/src/` |
| Migration: session business, password resets, `phone_taken()` | `db/migrations/0002_auth.sql` |

## How enforcement works

Every request goes through one guard, in this order:

1. **401** if the access token is missing, invalid or expired.
2. **403 `not_a_member`** if the membership is not active, the user is disabled or the business is deleted. This is checked in the database on every request, so disabling a member takes effect immediately rather than when their token expires.
3. **403 `insufficient_role`** if the route's `roles` list excludes the caller.
4. **402 `subscription_read_only`** or **`subscription_paused`** if the subscription doesn't allow what the route needs.

Each route declares what it needs:

| Route needs | full (trialing, active, past_due) | read_only | paused / cancelled |
|---|---|---|---|
| `write` (default for POST/PATCH/PUT/DELETE) | ✅ | ❌ 402 | ❌ 402 |
| `read` (default for GET) | ✅ | ✅ | ❌ 402 |
| `always` (billing, `/me`, auth) | ✅ | ✅ | ✅ |

**The status is derived from timestamps on every request.** The stored status is only a cache that the worker updates, so a late or failed sweep can never extend anyone's access.

**Seat limits are enforced twice:**
- The API checks first and returns a friendly 402 `seat_limit_reached`. Pending invitations count toward the limit.
- A database trigger (`KD001` → 402) is the final word. It covers invitation acceptance and re-enabling a member, under an advisory lock so concurrent requests can't both slip through.

## API (v1)

| Method | Path | Auth | Roles | Notes |
|---|---|---|---|---|
| POST | `/v1/auth/signup` | none | – | `{businessName, fullName, email, password, phone?, acceptTerms: true}` → 201 |
| POST | `/v1/auth/login` | none | – | `{email, password, businessId?}` |
| POST | `/v1/auth/refresh` | cookie + `x-kasadesk-csrf: 1` | – | rotates the refresh cookie |
| POST | `/v1/auth/logout` | cookie + csrf | – | revokes the session family |
| POST | `/v1/auth/switch-business` | user + csrf | – | `{businessId}` → new access token |
| POST | `/v1/auth/password/forgot` | none | – | always 202 |
| POST | `/v1/auth/password/reset` | none | – | `{token, password}`; logs out everywhere |
| GET | `/v1/me` | user | – | businesses, role, plan, trial/subscription timeline |
| GET/PATCH | `/v1/business` | tenant | PATCH: owner, admin | retention days: owner only |
| GET/PATCH | `/v1/business/settings` | tenant | PATCH: owner, admin | routing strategy, SLA 5/10 min, greeting, away message, language |
| GET/PUT | `/v1/business/hours` | tenant | PUT: owner, admin | split shifts allowed, overlaps rejected |
| GET | `/v1/members` | tenant | all | |
| PATCH | `/v1/members/:id` | tenant | owner, admin | role, status, skills (`lang:tw`, `product:phones`), capacity. Only the owner manages admins. |
| GET/POST | `/v1/invitations` | tenant | owner, admin | only the owner invites admins |
| DELETE | `/v1/invitations/:id` | tenant | owner, admin | |
| POST | `/v1/invitations/accept` | none | – | new account (`fullName`) or existing (password proves identity) |
| GET | `/v1/audit-logs` | tenant | owner, admin | `?limit&before` |
| GET | `/v1/billing/plans` | none | – | GH₵ prices |
| GET | `/v1/billing/subscription` | tenant (`always`) | all | status, days left, seats used/max |
| POST | `/v1/billing/plan` | tenant (`always`) | owner | trial only. Blocks downgrades below the active member count. |

Errors always look like `{ "error": { "code", "message", "details?" } }`.

## Token design (built for patchy mobile data)

**Access token**
- HS256 JWT, valid 15 minutes, kept in memory by the PWA.
- Carries only the user and business ids. Role is re-read from the database on each request.

**Refresh token**
- 32 random bytes, stored as a sha256 hash.
- Sent as an `httpOnly`, `Secure`, `SameSite=Strict` cookie scoped to `/v1/auth`, never in a response body.
- Rotated on every use.
- **Reuse detection:** presenting an already-rotated token revokes the whole session family. The exception is a 60-second grace window: if the network drops a refresh response and the phone retries with the old token, it gets a fresh token instead of being logged out.
- **CSRF protection:** cookie-authenticated endpoints require the `x-kasadesk-csrf: 1` header. Only allowed origins can send it (it triggers a CORS preflight).

**Logins**
- Passwords: argon2id at OWASP's minimum parameters (19 MiB, t=2).
- Unknown email and wrong password take the same time and return the same error.
- Failed logins are limited per email (10 per 15 minutes, which also stops attacks spread across many IPs) and per IP (10 per minute).

## Setup

```bash
cd kasadesk
pnpm install
cp .env.example .env            # then set JWT_ACCESS_SECRET and ENCRYPTION_KEYS
docker compose -f infra/docker-compose.yml up -d   # or your own Postgres 16 + Redis 7
pnpm db:migrate                 # applies db/migrations/*.sql in order (idempotent)
pnpm dev:api                    # http://localhost:3000/healthz
pnpm dev:worker                 # subscription sweep every 10 minutes
```

Production build: `pnpm --filter @kasadesk/server build`, then `node dist/main.api.js`, `node dist/main.worker.js`, and `MIGRATIONS_DIR=… node dist/platform/db/migrate.cli.js`.

**Existing database from step 1?** If you created it with `infra/initdb` (Docker), `schema_migrations` already records 0001. `pnpm db:migrate` then applies only 0002.

## Tests

```bash
# needs Postgres (superuser "postgres"/"postgres" on localhost) and Redis on localhost:6379
pnpm test
# override: TEST_PG_ADMIN_URL, TEST_PG_HOST, TEST_PG_PORT, TEST_REDIS_URL (uses Redis DB 15)
```

The suite creates a fresh `kasadesk_test` database on each run and uses the real RLS-restricted role. It covers:
- tenant isolation through the API;
- RBAC;
- invitations, including an existing user joining a second business;
- seat limits from both the API and the database trigger;
- downgrade blocking;
- trial → read-only → paused, and the paid grace period;
- sweep transitions and one-time reminders;
- token rotation, the grace window and reuse detection;
- CSRF, password reset, login lockout and HTTP rate limits;
- the startup role check;
- crypto rotation and tamper detection;
- phone normalization.

## Assumptions made in this step

1. **Trial plan choice is free.** During the trial, the owner can switch between plans as long as the active members fit. After the trial, plan changes go through checkout (step 7), which handles payment and proration.
2. **The owner can't be disabled or demoted** through member updates. Ownership transfer will be a separate, deliberate flow (not built yet).
3. **Phone numbers are unique per user.** This prepares for phone/OTP login later. Signup returns a clear `phone_taken` error.
4. **Default opening hours** are Monday–Saturday, 08:00–18:00 Africa/Accra. They can be edited.
5. **Email verification isn't enforced yet.** Invited users are marked verified, because receiving the invite proves they own the email. Signup verification is added with real email in step 6.
6. **Notifications are written to the log** until step 6 adds SMS and email providers. In production this would expose reset and invite links in the logs, so the API prints a warning at startup. A real notifier is required before launch.

## Things to do outside the code

1. Generate production secrets: `openssl rand -base64 48` (JWT) and `openssl rand -base64 32` (encryption key). Store them in your host's secret manager.
2. Serve the API and PWA over HTTPS on the same site (e.g. `app.example.com` and `api.example.com`) so `SameSite=Strict` cookies work.
3. Publish a **Privacy Notice and Terms**. Signup records acceptance of version `2026-11` (`TERMS_VERSION` in `auth/service.ts`). Have a lawyer review them against the Data Protection Act, 2012.
4. Set `TRUST_PROXY=true` behind a load balancer, so rate limits see real client IPs.
