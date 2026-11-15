# KasaDesk — Step 3: WhatsApp Cloud API and Web Chat Widget

## Message flow

```
Meta ──POST /webhooks/whatsapp──► gateway: verify X-Hub-Signature-256 on raw body
                                  → INSERT webhook_events (dedupe: sha256 of body) → enqueue → 200
worker (kd-inbound) ─► parse ─► resolve phone_number_id → tenant ─► contact unification
                       ─► conversation (one open per contact+channel) ─► message (unique wamid)
                       ─► outbox: media.download, message.created, conversation.updated

Agent ──POST /v1/conversations/:id/messages {clientId, text|template}
        → 24h window check → message 'queued' + outbox 'message.send' (same transaction)
outbox relay ─► kd-outbound ─► dispatcher: claim (queued→sending) → Graph POST /{phone-number-id}/messages
                              → sent + wamid | retry with backoff | failed with Meta error code
Meta receipts (sent/delivered/read/failed) ─► same webhook ─► status only moves forward (row lock)
```

**Every step is idempotent:**

| Layer | Mechanism |
|---|---|
| Gateway | Same body hashes to the same `webhook_events` row, so a retried webhook isn't stored twice |
| Inbound messages | Unique (channel, provider message id) |
| Agent sends | Unique `client_id` |
| Jobs | BullMQ job ids |
| Dispatcher | Conditional claim with a 2-minute lease |
| Receipts | `SELECT … FOR UPDATE`, plus a forward-only status order |

A recovery sweep (every minute) re-enqueues anything stuck after a Redis or worker crash.

## Connecting a WhatsApp number

`POST /v1/channels/whatsapp` (owner or admin):

```json
{ "name": "Main line", "phoneNumberId": "1234...", "wabaId": "5678...", "accessToken": "EAAG...", "mode": "platform" }
```

| Mode | When to use | Webhook URL | Signature secret |
|---|---|---|---|
| `platform` | Your Meta app is the integration (production; needs your app approved, plus Embedded Signup later) | `https://API/webhooks/whatsapp` (one URL for everyone) | `META_APP_SECRET` |
| `byo` | Pilots before your Meta app review: the business uses **its own** Meta app | Per channel, returned once as `webhookUrl` + `verifyToken` | That app's secret (`appSecret` in the request) |

When a number is connected, KasaDesk:
1. Checks it with `GET /{phone-number-id}`.
2. In platform mode, subscribes your app with `POST /{waba-id}/subscribed_apps`.
3. Encrypts the token with AES-256-GCM, bound to the channel id.
4. Queues a template sync.

**Safety rules for the two modes:**
- A BYO app's secret can only deliver events for **its own** number. Events naming other numbers are ignored (tested).
- Platform events only reach channels connected in platform mode.

**Disconnecting** (`DELETE /v1/channels/:id`) wipes the credentials and ignores any further webhooks, but keeps the conversation history.

## The 24-hour window and templates

**The 24-hour window**
- Free-form replies are allowed only within 24 hours of the customer's **last inbound message on that number**. The window is computed from messages, not the conversation, so it's correct across reopened conversations.
- Outside the window, the API returns **422 `outside_service_window`**, with `windowClosedAt`.
- `GET /v1/conversations/:id` returns `replyWindow.freeFormAllowed` and `closesAt`, so the PWA (step 4) can switch the composer to the template picker.

**Templates**
- **Sync:** templates are synced from `GET /{waba-id}/message_templates` on connect, on demand (`POST /v1/channels/:id/templates/sync`), and whenever Meta sends a `message_template_status_update` webhook.
- **Sending:** send with `{ "template": { "name", "language", "headerParams"?, "bodyParams"? } }`. The template must be `APPROVED` and the parameter count must match its `{{n}}` placeholders. The inbox shows the rendered text.
- **Not built yet:**
  - **Named parameters** and **media headers**. Only positional `{{n}}` text parameters are supported.
  - **Creating templates** from KasaDesk. Businesses create them in WhatsApp Manager.

## Errors and retries

| Meta signal | What happens |
|---|---|
| HTTP 5xx / 429, codes 1, 2, 4, 17, 80007, 130429, 131000, 131016, 131056, 133004 | Back to `queued`, retried up to 6 times with exponential backoff |
| Anything else (e.g. 131047 re-engagement, 131026 undeliverable, 190 bad token) | `failed` immediately, with `error_code` and `error_message` for the agent |
| `failed` receipt webhook | `failed`, with Meta's code and title |

Receipt `pricing` objects are saved on the message (`payload.pricing`) for metering in step 7.

## Media

Inbound images, voice notes, video and documents are downloaded by the worker:
1. `GET /{media-id}` returns a short-lived URL.
2. The file is downloaded with the bearer token.
3. It's stored in object storage (local disk, S3 or R2), at most `MEDIA_MAX_BYTES`.

Agents fetch media through `GET /v1/attachments/:id/content`, which checks the tenant. Voice notes stay available for transcription in step 8.

## Web chat widget

**Embed:** create the channel with `POST /v1/channels/webchat` (`allowedOrigins`, `title`, `greeting`, `color`, `askForContact`, `privacyNoticeUrl`). It returns `embedSnippet`:

```html
<script src="https://YOUR-CDN/widget.js" data-kasadesk-key="wc_…" data-kasadesk-api="https://YOUR-API" async></script>
```

**Size:** 9.4 KB gzipped (budget: 20 KB; the build fails above that). It's pure ASCII, so it renders correctly even when served without a charset.

**Rendering:** Preact inside Shadow DOM, so the host site's CSS can't break it. It goes full-screen on phones and is keyboard accessible.

**Offline sending:** messages are stored in localStorage and resent with the same `clientId`, so they're never duplicated (tested in a real browser with the network cut).

**Polling** (no WebSocket needed on customers' sites):

| Widget state | Polls every |
|---|---|
| Panel open | 3 s |
| Panel closed | 20 s |
| Tab hidden | 60 s |
| After errors | Backs off up to 60 s |

**Public API** (`/widget/v1/*`): `session`, `messages` (POST/GET with an `after` cursor), `identify`.
- **CORS** is open for these routes. The widget's `allowedOrigins` is enforced when a session starts.
- **Visitor tokens** are signed and bound to one widget.
- **Contacts:** a contact is created on the visitor's first message, not on page view.

**Identify:** a visitor can give a name and phone **with consent**. Consent is recorded in `contact_consent_events` with source, IP and origin. If the phone already belongs to a customer (e.g. from WhatsApp), the visitor is **merged** into that customer. The inbox then shows one person across both channels.

## Environment variables (new in this step)

`PUBLIC_API_URL`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_GRAPH_VERSION`, `META_GRAPH_BASE_URL`, `META_SKIP_CONNECT_CHECK`, `WIDGET_TOKEN_SECRET`, `WIDGET_SCRIPT_URL`, `WIDGET_RATE_LIMIT_PER_MINUTE`, `STORAGE_DRIVER`, `STORAGE_LOCAL_DIR`, `S3_*`, `MEDIA_MAX_BYTES`. See `.env.example`.

The **worker** now also needs `DATABASE_URL`: tenant work runs under RLS, and only the sweeps use `DATABASE_SYSTEM_URL`.

## Setup

```bash
pnpm install && pnpm db:migrate          # applies 0003_channels
pnpm dev:api & pnpm dev:worker
pnpm --filter @kasadesk/widget build      # dist/widget.js -> host on a CDN; set WIDGET_SCRIPT_URL
pnpm --filter @kasadesk/widget dev        # demo page on :5174 (edit the key in index.html)
```

**Receiving real webhooks locally:**
1. Expose the API over HTTPS (e.g. a tunnel).
2. In the Meta app: **WhatsApp → Configuration → Webhook**, set the URL to `https://…/webhooks/whatsapp` and the verify token to `META_VERIFY_TOKEN`.
3. Subscribe the **messages** and **message_template_status_update** fields.

## Tests

| Suite | Covers |
|---|---|
| Unit (12) | Webhook parsing for every message type, statuses, pricing, template events; signatures; the 24-hour window; template building; Graph message mapping; receipt ordering |
| WhatsApp integration (19) | Real HTTP to a local fake Graph server, real BullMQ workers, Postgres and Redis: verification, signature rejection, connect (Graph calls, encryption, template sync), duplicate webhooks, tenant isolation, unknown numbers, read-only accounts, voice-note download and serving, sending with wamid and first response, receipts out of order and **in parallel**, offline idempotency, the 24-hour window, templates, retries vs permanent failures, failed receipts, disconnect, BYO isolation, template webhooks |
| Web chat integration (8) | Origins, sessions, idempotent sends, agent replies, the poll cursor, read marking, returning visitors, identify + merge + consent, forged tokens, CORS split, realtime events through the outbox |
| Real-browser end-to-end (2, Chromium) | Phone viewport; the visitor chats, the agent replies, the network drops, messages are delivered exactly once; history survives a reload; disallowed sites get nothing |

## Assumptions

1. **No Embedded Signup yet.** Numbers are connected by pasting the phone number id, WABA id and a **system-user permanent token**. Embedded Signup needs Tech Provider status, so it's added once your app is approved.
2. **Inbound messages are stored while read-only or paused,** but nothing goes out (402). No customer message is lost.
3. **Replying to a resolved conversation reopens it,** unless a newer conversation with that customer on that channel is open. In that case the API returns 409 with the open conversation's id.
4. **Unknown message types are kept as `unsupported`** rather than dropped, so agents can see that something arrived.
5. **Web chat counts as delivered when stored,** and as read when the open widget fetches it.

## Third-party items to verify

| # | Item |
|---|---|
| F1 | **Meta App Review:** request `whatsapp_business_messaging` and `whatsapp_business_management` with Advanced Access. Also complete **Business Verification**. Without these, only test numbers or your own business work in platform mode. |
| F2 | **Tech Provider / Embedded Signup:** enroll before onboarding other businesses at scale. BYO mode is a bridge for pilots, and each pilot business must create its own Meta app. |
| F3 | **Graph API version:** set `META_GRAPH_VERSION` to the current version in Meta's changelog, and review it each time Meta deprecates one. |
| F4 | **Retryable error codes** (in `channels/whatsapp/client.ts`): check them against Meta's current Cloud API error-code reference. |
| F5 | **24-hour rule:** check Meta's current policy, including the longer free windows for ad-referred chats, which aren't modelled yet. |
| F6 | **Phone numbers and usernames:** today `wa_id` is the phone number. If Meta's planned WhatsApp usernames mean some webhooks arrive without a phone number, KasaDesk still works: the contact is keyed by handle, and phone-based unification just won't apply. Check Meta's announcements. |
| F7 | **Pricing:** the receipt `pricing` field shape. Confirm how it should be metered before step 7 (per-message pricing since 2025). |

## What you need to do outside the code

1. In your Meta app, add the **WhatsApp** product.
2. Create a **System User** in Business Manager with `whatsapp_business_messaging` and `whatsapp_business_management`, and generate a **permanent token**.
3. Set `META_APP_SECRET` and `META_VERIFY_TOKEN`, then register the webhook URL and subscribe the fields listed in Setup.
4. Submit App Review (F1). Start Tech Provider enrollment (F2).
5. Host `widget.js` on a CDN over HTTPS, and set `WIDGET_SCRIPT_URL` and `PUBLIC_API_URL`.
6. Create an S3 or R2 bucket for media (private, no public access), and set `STORAGE_DRIVER=s3` and the `S3_*` variables.
7. Add a sentence about the chat widget to your customers' privacy notices, and set `privacyNoticeUrl` on each widget.
