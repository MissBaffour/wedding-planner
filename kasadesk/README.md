# KasaDesk

An omnichannel customer inbox for Ghanaian businesses: WhatsApp, Instagram, Messenger, SMS, email and web chat, all in one inbox.

## Status

| Step | Scope | State |
|---|---|---|
| 1 | Stack, folder structure, database schema | ✅ done |
| 2 | Auth, multi-tenancy, trial and plan enforcement | ✅ done |
| 3 | WhatsApp Cloud API + web chat widget | next |
| 4 | Inbox PWA | |
| 5 | Automation and queue engine | |
| 6 | Instagram, Messenger, SMS, email | |
| 7 | MoMo billing and in-chat payments | |
| 8 | Language detection, transcription, analytics | |

Design, assumptions and third-party flags: [`docs/01-architecture.md`](docs/01-architecture.md).
Auth, tenancy, trial and plan enforcement: [`docs/02-auth-tenancy.md`](docs/02-auth-tenancy.md).

## Run the API

```bash
pnpm install
cp .env.example .env     # set JWT_ACCESS_SECRET and ENCRYPTION_KEYS
pnpm db:migrate
pnpm dev:api             # and in another terminal: pnpm dev:worker
pnpm test                # needs local Postgres + Redis, see docs/02
```

## Database quick start

Option A: Docker. This creates the roles and the `kasadesk` database, and applies the migrations.

```bash
chmod +x infra/initdb/10-kasadesk.sh
docker compose -f infra/docker-compose.yml up -d
```

Option B: an existing Postgres 16+ server. You need superuser access.

```bash
psql -U postgres -v app_pw=... -v sys_pw=... -v mig_pw=... -f db/roles.sql
psql -U postgres -c "CREATE DATABASE kasadesk OWNER kasadesk_migrator"
psql -U postgres -d kasadesk -c "SET ROLE kasadesk_migrator" -f db/migrations/0001_init.sql
```

## Schema tests

These create a throwaway database, apply everything and run the tests as the RLS-restricted app role.

```bash
PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres ./db/scripts/verify.sh
```
