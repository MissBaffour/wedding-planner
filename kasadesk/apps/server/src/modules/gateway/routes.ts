import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import type { Config } from '../../platform/config.ts';
import { sha256, type Keyring } from '../../platform/crypto.ts';
import type { DB } from '../../platform/db/index.ts';
import { useRawJsonBody } from '../../platform/http/raw-body.ts';
import type { Queues } from '../../platform/queues.ts';
import { decryptCredentials } from '../channels/core/repo.ts';
import { verifyMetaSignature } from '../channels/whatsapp/signature.ts';

export const WEBHOOK_PROVIDER = { whatsapp: 'whatsapp', whatsappByo: 'whatsapp_byo' } as const;

/**
 * Webhook gateway. Rules:
 *  - verify the signature on the RAW body before anything else
 *  - persist the raw event (deduped by body hash) and enqueue it
 *  - answer 200 fast; all real work happens in the worker
 * Enqueue failures are not fatal: the worker's recovery sweep re-enqueues unprocessed events.
 */
export function gatewayRoutes(app: FastifyInstance, deps: { db: DB; config: Config; keyring: Keyring; queues: Queues }) {
  const { db, config, keyring, queues } = deps;

  const persistAndEnqueue = async (req: FastifyRequest, provider: string, ids: { businessId?: string; channelId?: string }) => {
    const dedupeKey = sha256(req.rawBody!).toString('hex');
    const r = await db.insertInto('webhook_events')
      .values({
        provider, dedupe_key: dedupeKey, signature_valid: true, payload: req.rawBody!.toString('utf8'),
        business_id: ids.businessId ?? null, channel_id: ids.channelId ?? null,
      })
      // No conflict target: the gateway role may INSERT but not SELECT webhook_events, and a
      // targeted ON CONFLICT needs SELECT. The only unique key besides the identity is (provider, dedupe_key).
      .onConflict((oc) => oc.doNothing())
      .executeTakeFirst();
    if (Number(r.numInsertedOrUpdatedRows ?? 0) > 0) {
      await queues.inbound.add('event', { provider, dedupeKey }, { jobId: `wh-${provider}-${dedupeKey}` })
        .catch((err) => req.log.warn({ err }, 'enqueue failed; recovery sweep will retry'));
    }
  };

  const challenge = (req: FastifyRequest, reply: FastifyReply, expectedToken: string | undefined) => {
    const q = req.query as Record<string, string>;
    if (expectedToken && q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === expectedToken) {
      return reply.type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.status(403).send({ error: { code: 'verification_failed', message: 'Invalid verify token' } });
  };

  app.register(async (scope) => {
    useRawJsonBody(scope);
    const cfg = { auth: 'none' as const, rateLimit: false as const };

    // ---- Platform app (your Meta app; one URL for all businesses) ----
    scope.get('/webhooks/whatsapp', { config: cfg }, async (req, reply) => challenge(req, reply, config.META_VERIFY_TOKEN || undefined));

    scope.post('/webhooks/whatsapp', { config: cfg }, async (req, reply) => {
      if (!config.META_APP_SECRET) return reply.status(404).send();
      if (!verifyMetaSignature(req.rawBody!, req.headers['x-hub-signature-256'] as string | undefined, config.META_APP_SECRET)) {
        req.log.warn('whatsapp webhook: bad signature');
        return reply.status(401).send({ error: { code: 'bad_signature' } });
      }
      await persistAndEnqueue(req, WEBHOOK_PROVIDER.whatsapp, {});
      return reply.status(200).send({ ok: true });
    });

    // ---- Bring-your-own Meta app (per-channel URL, secret and verify token) ----
    const byoChannel = async (key: string) => {
      const r = await sql<{
        business_id: string; channel_id: string; type: string; status: string; external_id: string;
        credentials_enc: Buffer | null; credentials_key_id: string | null;
      }>`select * from resolve_channel_by_webhook_key(${key})`.execute(db);
      const c = r.rows[0];
      if (!c || c.type !== 'whatsapp' || c.status === 'disconnected') return null;
      return { ...c, credentials: decryptCredentials(keyring, { id: c.channel_id, ...c }) };
    };

    scope.get('/webhooks/whatsapp/:key', { config: cfg }, async (req, reply) => {
      const c = await byoChannel((req.params as { key: string }).key);
      return challenge(req, reply, c?.credentials.verifyToken);
    });

    scope.post('/webhooks/whatsapp/:key', { config: cfg }, async (req, reply) => {
      const c = await byoChannel((req.params as { key: string }).key);
      if (!c) return reply.status(404).send();
      if (!verifyMetaSignature(req.rawBody!, req.headers['x-hub-signature-256'] as string | undefined, c.credentials.appSecret ?? '')) {
        req.log.warn({ channelId: c.channel_id }, 'whatsapp byo webhook: bad signature');
        return reply.status(401).send({ error: { code: 'bad_signature' } });
      }
      await persistAndEnqueue(req, WEBHOOK_PROVIDER.whatsappByo, { businessId: c.business_id, channelId: c.channel_id });
      return reply.status(200).send({ ok: true });
    });
  });
}
