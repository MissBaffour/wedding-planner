# KasaDesk — Step 1: Stack, Structure, Schema

## 1. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript 5** end to end | One language for API, worker, PWA and widget; shared zod schemas. |
| Runtime | **Node.js 24 LTS** (22 LTS also works) | Long support window; native `fetch`, `crypto`, test runner. |
| Monorepo | **pnpm workspaces** | Fast installs, strict deps, one lockfile. |
| HTTP API | **Fastify 5** + `fastify-type-provider-zod` | Fast, low memory, raw-body access for webhook signature checks, schema validation built in. |
| Validation | **zod** | One `Message` schema shared by server, PWA and widget. |
| Database | **PostgreSQL 16+** | Row-level security for multi-tenancy, JSONB for channel payloads, partial unique indexes for idempotency. |
| SQL access | **Kysely** (typed query builder) + **plain SQL migrations** | Stays close to SQL (RLS and `SET LOCAL` are explicit), no ORM magic hiding tenant scoping. |
| Queues | **Redis 7 (or Valkey) + BullMQ** | Retries with backoff, delayed jobs (SLA timers, 24 h window checks), rate-limited queues per channel. |
| Presence | Redis keys with TTL + heartbeats | Agent online/away/offline drives routing and auto-reassign. |
| Realtime | **Socket.IO 4** + Redis adapter | Reconnects on its own and falls back to long-polling on weak 3G/4G; rooms per business/agent/conversation. Clients resume with a `since` cursor so nothing is lost after a drop. |
| Auth | argon2id (`@node-rs/argon2`), JWT access token (15 min, `jose`), rotating refresh token in an httpOnly cookie | Short-lived tokens, refresh-token reuse detection (see `auth_sessions.family_id`). |
| Secret storage | AES-256-GCM envelope encryption, key id stored per row | Channel tokens encrypted at rest; keys can be rotated. Swap the env key for a cloud KMS later without schema changes. |
| Media | S3-compatible object storage (Cloudflare R2 or AWS S3) | Channel media URLs expire (e.g. WhatsApp), so we copy files in. R2 has no egress fees, which matters for media-heavy chats. |
| Agent app | **React + Vite + vite-plugin-pwa (Workbox)**, TanStack Query, **Dexie (IndexedDB)**, Tailwind CSS | Installable PWA; caches the inbox for offline reading; IndexedDB outbox resends queued replies when data returns (idempotent through `messages.client_id`). Target: under 200 KB gzipped JS on first load. |
| Chat widget | **Preact**, one `<script>` tag | Target under 20 KB gzipped so it does not slow customers' websites. |
| Notifications | Web Push (VAPID) | Works on Android Chrome for installed PWAs; iOS only supports it for PWAs added to the home screen. |
| Tests | **Vitest**, `fastify.inject`, Postgres + Redis from docker compose, **Playwright** for PWA end-to-end | Same database engine in tests as in production. |
| Observability | pino logs (with secrets redacted), OpenTelemetry, Sentry (optional) | |
| Deploy | Docker images: `api`, `worker`, static `web` + `widget` on a CDN; managed Postgres + Redis | Works on Render, Fly.io, Railway, DigitalOcean or AWS. |

**Third-party providers (each one is decided in its own step and kept behind an adapter interface):**

- Payments: **Paystack (Ghana)** for subscriptions and card payments, with **Hubtel** or the **MTN MoMo API** as alternatives. In-chat payments go to the business's own account.
- SMS: **Hubtel** and **Arkesel** adapters.
- Email: an inbound-parse provider (Postmark, Mailgun or Amazon SES), chosen in step 6.
- Speech-to-text and language: chosen in step 8. Candidates are GhanaNLP (Khaya) for Twi, a Whisper-class model for English and Pidgin, and an LLM for reply suggestions.

## 2. Runtime architecture

```
Providers (Meta, Hubtel/Arkesel, email, Paystack/MoMo, widget)
        │ HTTPS webhooks
        ▼
┌──────────────────── api process (Fastify) ────────────────────┐
│ Webhook gateway                                                │
│   1. verify signature on RAW body (HMAC / provider scheme)     │
│   2. INSERT webhook_events ON CONFLICT DO NOTHING (dedupe)     │
│   3. enqueue `inbound` job  → return 200 (target < 100 ms)     │
│ REST API (auth, inbox, settings)  ── plan guard ── RLS tx      │
│ Socket.IO (rooms: business, agent, conversation)               │
└──────────────┬─────────────────────────────────────────────────┘
               │ BullMQ (Redis)
               ▼
┌──────────────────── worker process ───────────────────────────┐
│ inbound:  channel adapter.parse() → normalized Message         │
│           → resolve tenant (resolve_channel) → contact unify   │
│           → conversation service (upsert, idempotent insert)   │
│           → outbox event `message.received`                    │
│ automation: rules engine (greeting, hours, keywords) → routing │
│ routing:  queue position, round-robin / least-busy / skills,   │
│           SLA timers (delayed jobs at 5 & 10 min), offline     │
│           reassign (presence expiry)                           │
│ outbound: dispatcher → adapter.send() with retries + backoff,  │
│           per-channel rate limits, 24 h window / template rule │
│ scheduler: trial/grace/read-only transitions, invoices,        │
│           retention purge, outbox relay, template sync         │
└────────────────────────────────────────────────────────────────┘
       Postgres (RLS)        Redis (queues, presence, pub/sub)      Object storage
```

**Idempotency happens at three layers.**

1. **Gateway:** `webhook_events (provider, dedupe_key)`, where `dedupe_key` is the sha256 of the raw body or the provider's event id.
2. **Domain:** `messages (channel_id, provider_message_id)` for inbound messages and `messages (business_id, client_id)` for agent sends. Status receipts update the row and never insert.
3. **Side effects:** `automation_runs (rule_id, event_key)`, `payment_requests (provider, provider_reference)`, `billing_payments (provider, provider_reference)`, and `invoices (business_id, period_start)`.

**Transactional outbox.** Domain writes and their follow-up events are written to `outbox` in the same transaction. The worker then relays them to BullMQ. This way, if Redis is briefly down, no reply or automation is lost.

## 3. Multi-tenancy model

- Every tenant table has `business_id`, and RLS is on: `business_id = current_setting('app.business_id')`.
- Every request runs inside `BEGIN; SET LOCAL app.business_id = $1; SET LOCAL app.user_id = $2; …; COMMIT`. The value is transaction-local, so a pooled connection can never carry one tenant's context into another request.
- **Fail closed:** with no context set, queries return zero rows (tested).
- **Composite foreign keys** such as `(business_id, conversation_id)` mean that even a bug that sets the right tenant cannot link a row to another tenant's data (tested).
- **Database roles:**
  - `kasadesk_app` (RLS enforced) is used by the API and by tenant-scoped worker jobs.
  - `kasadesk_system` (BYPASSRLS) is used only by cross-tenant sweeps and the outbox relay. A lint rule restricts which files may import it.
  - `kasadesk_migrator` owns the schema.
- A few lookups have to happen before the tenant is known. These are narrow `SECURITY DEFINER` functions: `resolve_channel` (webhook routing), `auth_lookup_user`, `auth_user_businesses` and `auth_find_invitation`.

## 4. Subscription state machine (enforced at the API layer in step 2)

```
signup ─► trialing (14 days, Growth limits, no card)
            │ trial_ends_at passes, unpaid
            ▼
          read_only (7 days: view + export; no replies, no automations, no new channels)
            │ read_only_ends_at passes
            ▼
          paused (UI locked to billing/export pages)

active ─► period ends unpaid ─► past_due (3-day grace, full access, reminders by SMS/email)
            ─► read_only (7 days) ─► paused
Any state ─► payment confirmed by webhook ─► active (new period)
```

During `read_only` and `paused`, inbound customer messages are **still stored** so that no customer message is lost. They are just not answered, routed or automated until the account is reactivated.

## 5. Folder structure (filled in over steps 2–8)

```
kasadesk/
├── apps/
│   ├── server/                      # modular monolith: two entry points, one codebase
│   │   ├── src/
│   │   │   ├── main.api.ts          # Fastify: REST + webhooks + Socket.IO
│   │   │   ├── main.worker.ts       # BullMQ processors + scheduler
│   │   │   ├── platform/            # cross-cutting, no business logic
│   │   │   │   ├── config.ts        # env parsing (zod)
│   │   │   │   ├── db/              # pools (app/system), withTenant(tx), Kysely types
│   │   │   │   ├── crypto.ts        # envelope encryption for channel tokens
│   │   │   │   ├── queue.ts redis.ts realtime.ts logger.ts
│   │   │   │   ├── http/            # error mapping, rate limiting, auth hooks
│   │   │   │   └── audit.ts
│   │   │   └── modules/             # each exposes ONLY ./index.ts to other modules
│   │   │       ├── auth/            # signup, login, refresh, invitations, RBAC
│   │   │       ├── tenancy/         # businesses, memberships, settings, hours
│   │   │       ├── billing/         # plans, trial state machine, invoices, metering
│   │   │       ├── gateway/         # webhook endpoints: verify → persist → enqueue → 200
│   │   │       ├── channels/
│   │   │       │   ├── core/        # ChannelAdapter interface, normalized Message
│   │   │       │   ├── whatsapp/ instagram/ messenger/
│   │   │       │   ├── sms/         # hubtel/, arkesel/
│   │   │       │   ├── email/
│   │   │       │   └── webchat/
│   │   │       ├── contacts/        # unification (phone → handle), merge, consent
│   │   │       ├── conversations/   # inbox queries, assignment, notes, tags, resolve
│   │   │       ├── messaging/       # outbound dispatcher, retries, 24 h window
│   │   │       ├── automation/      # rules engine, greeting, business hours, keywords
│   │   │       ├── routing/         # queue, strategies, presence, SLA escalation
│   │   │       ├── payments/        # in-chat MoMo requests + webhooks
│   │   │       ├── intelligence/    # language detection, suggestions, transcription, GPS
│   │   │       ├── insights/        # FRT, resolution time, SLA, sales, per-agent
│   │   │       └── compliance/      # export, erasure, retention purge
│   │   └── test/
│   ├── web/                         # React PWA (agents + admins)
│   └── widget/                      # Preact website chat widget
├── packages/
│   └── shared/                      # zod schemas (Message, events), phone + GPS utils, i18n
├── db/
│   ├── roles.sql                    # one-time role creation
│   ├── migrations/                  # 0001_init.sql, 0002_..., applied in order
│   ├── tests/                       # SQL tests run as kasadesk_app
│   └── scripts/verify.sh
├── infra/docker-compose.yml         # Postgres 16 + Redis 7 for development
└── docs/
```

Module boundaries are enforced with `dependency-cruiser`. A module may only import another module's `index.ts`, and it may not read another module's tables directly. When the time comes to split a module into its own service, the cut is already in place.

## 6. Normalized message (summary, finalized as a zod schema in step 3)

```ts
type NormalizedInbound = {
  channelType: 'whatsapp'|'instagram'|'messenger'|'sms'|'email'|'webchat';
  channelExternalId: string;      // routes to the tenant via resolve_channel()
  providerMessageId: string;      // idempotency key
  from: { handle: string; phoneE164?: string; email?: string; name?: string };
  kind: 'text'|'image'|'audio'|'video'|'document'|'sticker'|'location'|'contact_card'
        |'interactive'|'reaction'|'unsupported';
  body?: string;                  // plain-text rendering
  payload: Record<string, unknown>; // structured content (media ids, location, buttons)
  replyToProviderId?: string;
  timestamp: string;              // provider time, ISO-8601
};
```

Contacts are unified as follows:

1. Look for an existing `contact_identities (channel_id, handle)`.
2. If there is none, match `contacts.phone_e164` (WhatsApp and SMS always carry a phone number; others may not).
3. If there is still no match, create a new contact. Instagram and Messenger contacts without a phone number stay separate until an agent merges them or the customer shares their number.

Merges set `merged_into_id` and move the identities and conversations to the surviving contact.

## 7. Assumptions

1. **The repository is reused.** This repository previously held a static wedding-planner page. KasaDesk lives in `kasadesk/`, and nothing existing was changed.
2. **Trials run on Growth limits** (8 seats, skill routing). On conversion, the business picks a plan. If it has more active members than the new plan allows, the downgrade is blocked until members are disabled.
3. **A seat is any active member** (owner, admin or agent). Invited and disabled members don't count.
4. **Billing period and grace.** Paid plans are billed monthly in advance. The 3-day grace period applies to lapsed paid periods. After the grace period, the account goes into the same 7-day read-only phase as an expired trial, then pauses.
5. **MoMo renewals are invoices, not auto-debits.** Mobile money generally can't be auto-debited like a card, so each renewal is an invoice plus a payment prompt (USSD/push) sent to the billing number. Card customers can use saved-card renewals if the provider supports it.
6. **Prices are VAT-inclusive.** Each invoice will show the tax breakdown once an accountant confirms the rates (VAT, NHIL, GETFund and COVID-19 levies change over time).
7. **Default retention is 730 days**, configurable per business between 30 and 3,650 days. Audit logs are kept separately.
8. **Supported languages** are `en`, `tw` (Twi/Akan) and `pcm` (Ghanaian Pidgin), plus `other`. Ga, Ewe, Dagbani and others can be added later as data.
9. **Single region.** All tenants share one database and one region. Read replicas or partitioning of `messages` by month come later, when volume justifies them.

## 8. Third-party items you must verify (flags)

| # | Item | Why it matters |
|---|---|---|
| F1 | **Meta Business Verification**, **App Review** for WhatsApp/Instagram/Messenger permissions, and **Tech Provider** enrollment for Embedded Signup | You can't onboard other businesses' WhatsApp numbers without these. Allow several weeks. |
| F2 | **WhatsApp pricing model** | Meta changed from per-conversation to per-message pricing in 2025, and rates vary by country and category. We record Meta's charge per billable message at cost (`usage_records`). Confirm on Meta's current rate card who is billed: the business's own payment method on its WABA (`billed_by = meta_direct`), or you as the Tech Provider (`kasadesk`). |
| F3 | **24-hour customer service window** and template rules | These are Meta policy and can change. Step 3 will implement them against Meta's current docs. |
| F4 | **Payments licensing (Bank of Ghana, Payment Systems and Services Act 2019, Act 987)** | KasaDesk must not collect money on behalf of businesses unless licensed. The design routes in-chat payments to each business's own Paystack, Hubtel or MoMo merchant account. Confirm with your provider and a lawyer. |
| F5 | **Paystack/Hubtel/MTN MoMo API access** | Each requires business KYC. Check which mobile-money networks your chosen provider supports for collections today. |
| F6 | **SMS sender ID registration** with Hubtel or Arkesel | Sender IDs need approval. Check the current rules on promotional SMS and opt-out. |
| F7 | **Ghana Post GPS** | There is no public API documentation I can confirm. The schema validates only the format (`GA-492-7465`). Resolving a code to coordinates needs an official or licensed source, to be confirmed before step 8. |
| F8 | **Data Protection Act, 2012 (Act 843)** | Register KasaDesk with the **Data Protection Commission** as a data controller/processor. Have a lawyer confirm the rules on cross-border transfer if you host outside Ghana, and the retention and erasure rules. Your customers (the businesses) are controllers of their customers' data, so you need a Data Processing Agreement in your terms. |
| F9 | **Twi/Pidgin speech-to-text quality** | Few commercial ASR models handle Twi well. Benchmark candidates on real voice notes in step 8 before promising the feature. |

## 9. What you need to do outside the code now

1. Start **Meta Business Verification** and create a Meta developer app. This takes the longest, so start first.
2. Open sandbox/test accounts with **Paystack (Ghana)** and/or **Hubtel**, and with **Arkesel**.
3. Choose hosting and a region, and confirm data-transfer requirements (F8).
4. Register a domain, and plan subdomains: `app.`, `api.`, `widget.`
5. Begin **Data Protection Commission** registration.
