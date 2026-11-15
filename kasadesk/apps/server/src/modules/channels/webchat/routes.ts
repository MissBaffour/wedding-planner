import { normalizePhone, uuidv7 } from '@kasadesk/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Config } from '../../../platform/config.ts';
import { withTenant, type DB, type Tx } from '../../../platform/db/index.ts';
import { Errors } from '../../../platform/errors.ts';
import { parse } from '../../../platform/http/validate.ts';
import { mergeContacts, recordConsent, resolveContact } from '../../contacts/service.ts';
import { ingestInbound } from '../../conversations/ingest.ts';

interface Visitor { visitorId: string; channelId: string; businessId: string }

const AUD = 'kasadesk-widget';
const VISITOR_TTL = '180d';

/**
 * Public API for the embeddable chat widget (no agent auth).
 * A visitor gets a signed token bound to one widget/channel; the visitor id is the
 * contact handle. Contacts are created on the first message, not on page view.
 */
export function webchatRoutes(app: FastifyInstance, deps: { db: DB; config: Config }) {
  const { db, config } = deps;
  const key = new TextEncoder().encode(config.WIDGET_TOKEN_SECRET);
  const limit = { max: config.WIDGET_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' };
  const routeCfg = { auth: 'none' as const, rateLimit: limit };

  const sign = (v: Visitor) =>
    new SignJWT({ cid: v.channelId, bid: v.businessId }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(v.visitorId).setAudience(AUD).setIssuedAt().setExpirationTime(VISITOR_TTL).sign(key);

  const verify = async (token: string | undefined): Promise<Visitor | null> => {
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, key, { audience: AUD, algorithms: ['HS256'] });
      if (typeof payload.sub !== 'string' || typeof payload.cid !== 'string' || typeof payload.bid !== 'string') return null;
      return { visitorId: payload.sub, channelId: payload.cid, businessId: payload.bid };
    } catch {
      return null;
    }
  };

  const visitorOf = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    const v = await verify(h?.startsWith('Bearer ') ? h.slice(7) : undefined);
    if (!v) throw Errors.unauthorized('invalid_visitor');
    return v;
  };

  /** The visitor's channel must still be active. */
  const activeChannel = async (tx: Tx, v: Visitor) => {
    const c = await tx.selectFrom('channels').select(['id', 'external_id', 'status', 'type']).where('id', '=', v.channelId).executeTakeFirst();
    if (!c || c.type !== 'webchat' || c.status !== 'active') throw Errors.notFound('widget_unavailable');
    return c;
  };

  const contactOf = (tx: Tx, v: Visitor) =>
    tx.selectFrom('contact_identities').innerJoin('contacts', 'contacts.id', 'contact_identities.contact_id')
      .select(['contacts.id', 'contacts.merged_into_id', 'contacts.display_name', 'contacts.phone_e164', 'contacts.email'])
      .where('contact_identities.channel_id', '=', v.channelId).where('contact_identities.handle', '=', v.visitorId)
      .executeTakeFirst();

  app.post('/widget/v1/session', { config: routeCfg }, async (req) => {
    const body = parse(z.object({ widgetKey: z.string().min(5).max(80), visitorToken: z.string().max(2000).optional() }), req.body);
    const r = await sql<{ business_id: string; channel_id: string; status: string }>`
      select * from resolve_channel('webchat', ${body.widgetKey})`.execute(db);
    const ch = r.rows[0];
    if (!ch || ch.status !== 'active') throw Errors.notFound('widget_unavailable');

    return withTenant(db, { businessId: ch.business_id, userId: null }, async (tx) => {
      const c = await tx.selectFrom('channels').select(['config']).where('id', '=', ch.channel_id).executeTakeFirstOrThrow();
      const cfg = c.config as { allowedOrigins?: string[]; title?: string; greeting?: string; color?: string; askForContact?: boolean; privacyNoticeUrl?: string };
      const origin = req.headers.origin;
      if (cfg.allowedOrigins?.length && (!origin || !cfg.allowedOrigins.includes(origin))) throw Errors.forbidden('origin_not_allowed');

      const prev = await verify(body.visitorToken);
      const visitorId = prev && prev.channelId === ch.channel_id ? prev.visitorId : uuidv7();
      const v = { visitorId, channelId: ch.channel_id, businessId: ch.business_id };
      const contact = await contactOf(tx, v);
      const biz = await tx.selectFrom('businesses').select('name').executeTakeFirstOrThrow();
      return {
        visitorToken: await sign(v),
        visitorId,
        widget: {
          businessName: biz.name, title: cfg.title ?? 'Chat with us', greeting: cfg.greeting ?? '', color: cfg.color ?? '#0f766e',
          askForContact: cfg.askForContact ?? true, privacyNoticeUrl: cfg.privacyNoticeUrl ?? null,
        },
        identified: Boolean(contact?.phone_e164 || contact?.email),
      };
    });
  });

  app.post('/widget/v1/messages', { config: routeCfg }, async (req, reply) => {
    const v = await visitorOf(req);
    const body = parse(z.object({ clientId: z.string().uuid(), text: z.string().trim().min(1).max(2000) }), req.body);
    const res = await withTenant(db, { businessId: v.businessId, userId: null }, async (tx) => {
      const ch = await activeChannel(tx, v);
      const r = await ingestInbound(tx, v.businessId, { id: ch.id, type: 'webchat' }, {
        channelType: 'webchat', channelExternalId: ch.external_id,
        providerMessageId: `wc-${body.clientId}`, // retries of the same clientId are no-ops
        from: { handle: v.visitorId, profile: { userAgent: req.headers['user-agent']?.slice(0, 200) } },
        kind: 'text', body: body.text, payload: {}, timestamp: new Date().toISOString(),
      });
      const m = await tx.selectFrom('messages').select(['id', 'created_at'])
        .where('channel_id', '=', ch.id).where('provider_message_id', '=', `wc-${body.clientId}`).executeTakeFirstOrThrow();
      return { id: m.id, clientId: body.clientId, createdAt: m.created_at, duplicate: r.duplicate };
    });
    return reply.status(res.duplicate ? 200 : 201).send(res);
  });

  /** Polled by the widget. `after` = last message id seen (ids are time-ordered UUIDv7). */
  app.get('/widget/v1/messages', { config: { auth: 'none', rateLimit: { max: Math.max(limit.max, 60), timeWindow: '1 minute' } } }, async (req) => {
    const v = await visitorOf(req);
    const q = parse(z.object({ after: z.string().uuid().optional(), seen: z.enum(['0', '1']).optional() }), req.query);
    return withTenant(db, { businessId: v.businessId, userId: null }, async (tx) => {
      await activeChannel(tx, v);
      const contact = await contactOf(tx, v);
      if (!contact) return { messages: [] };
      const contactId = contact.merged_into_id ?? contact.id;
      let query = tx.selectFrom('messages')
        .leftJoin('memberships', 'memberships.id', 'messages.sender_id')
        .select(['messages.id', 'messages.direction', 'messages.kind', 'messages.body', 'messages.created_at', 'messages.provider_message_id', 'messages.status', 'memberships.display_name as agent_name'])
        .where('messages.contact_id', '=', contactId).where('messages.channel_id', '=', v.channelId)
        .where('messages.status', '<>', 'failed')
        .orderBy('messages.id').limit(100);
      if (q.after) query = query.where('messages.id', '>', q.after);
      const rows = await query.execute();
      if (q.seen === '1') {
        await tx.updateTable('messages').set({ status: 'read', read_at: new Date() })
          .where('contact_id', '=', contactId).where('channel_id', '=', v.channelId)
          .where('direction', '=', 'outbound').where('status', '=', 'delivered').execute();
      }
      return {
        messages: rows.map((m) => ({
          id: m.id, from: m.direction === 'inbound' ? 'visitor' : 'business', kind: m.kind, text: m.body,
          createdAt: m.created_at, agentName: m.direction === 'outbound' ? m.agent_name : undefined,
          clientId: m.provider_message_id?.startsWith('wc-') ? m.provider_message_id.slice(3) : undefined,
        })),
      };
    });
  });

  /** Visitor shares contact details (with consent). A known phone links them to their existing customer record. */
  app.post('/widget/v1/identify', { config: routeCfg }, async (req) => {
    const v = await visitorOf(req);
    const body = parse(z.object({
      name: z.string().trim().min(1).max(80).optional(),
      phone: z.string().max(30).optional(),
      email: z.string().trim().toLowerCase().email().max(254).optional(),
      consent: z.literal(true, { errorMap: () => ({ message: 'Consent is required' }) }),
    }), req.body);
    const phone = body.phone ? normalizePhone(body.phone) : null;
    if (body.phone && !phone) throw Errors.badRequest('validation_failed', 'Enter a valid phone number, e.g. 024 123 4567', [{ path: 'phone', message: 'invalid' }]);

    return withTenant(db, { businessId: v.businessId, userId: null }, async (tx) => {
      await activeChannel(tx, v);
      let { contactId } = await resolveContact(tx, v.businessId, { id: v.channelId, type: 'webchat' }, { handle: v.visitorId, name: body.name });
      let linked = false;
      if (phone) {
        const existing = await tx.selectFrom('contacts').select('id').where('phone_e164', '=', phone)
          .where('merged_into_id', 'is', null).where('id', '<>', contactId).executeTakeFirst();
        if (existing) {
          await mergeContacts(tx, contactId, existing.id);
          contactId = existing.id;
          linked = true;
        } else {
          await tx.updateTable('contacts').set({ phone_e164: phone }).where('id', '=', contactId).execute();
        }
      }
      const patch = { ...(body.name && { display_name: body.name }), ...(body.email && { email: body.email }) };
      if (Object.keys(patch).length) await tx.updateTable('contacts').set(patch).where('id', '=', contactId).execute();
      await recordConsent(tx, v.businessId, contactId, {
        status: 'granted', purpose: 'service', source: 'webchat_form',
        evidence: { ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 200), origin: req.headers.origin ?? null },
      });
      return { ok: true, linkedToExistingCustomer: linked };
    });
  });
}
