import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { withTenant, type DB } from '../../platform/db/index.ts';
import { Errors } from '../../platform/errors.ts';
import { tenantOf } from '../../platform/http/guard.ts';
import { parse } from '../../platform/http/validate.ts';
import { isWithinServiceWindow, windowClosesAt } from '../channels/whatsapp/window.ts';
import { SendMessageBody, lastInboundAt, queueAgentMessage } from '../messaging/send.ts';

const idParam = z.object({ id: z.string().uuid() });

/** Minimal conversation API for step 3. Assignment, notes, tags and filters come in step 4. */
export function conversationRoutes(app: FastifyInstance, deps: { db: DB }) {
  const { db } = deps;

  app.get('/v1/conversations', async (req) => {
    const q = parse(z.object({
      status: z.enum(['open', 'pending', 'snoozed', 'resolved']).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }), req.query);
    return withTenant(db, tenantOf(req), (tx) => {
      let query = tx.selectFrom('conversations')
        .innerJoin('contacts', 'contacts.id', 'conversations.contact_id')
        .innerJoin('channels', 'channels.id', 'conversations.channel_id')
        .select([
          'conversations.id', 'conversations.status', 'conversations.assignee_id', 'conversations.last_message_at',
          'conversations.last_message_preview', 'conversations.unread_count', 'contacts.id as contact_id',
          'contacts.display_name', 'contacts.phone_e164', 'channels.type as channel_type', 'channels.name as channel_name',
        ])
        .orderBy('conversations.last_message_at', 'desc').limit(q.limit);
      if (q.status) query = query.where('conversations.status', '=', q.status);
      return query.execute();
    });
  });

  app.get('/v1/conversations/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return withTenant(db, tenantOf(req), async (tx) => {
      const c = await tx.selectFrom('conversations')
        .innerJoin('contacts', 'contacts.id', 'conversations.contact_id')
        .innerJoin('channels', 'channels.id', 'conversations.channel_id')
        .selectAll('conversations')
        .select(['contacts.display_name', 'contacts.phone_e164', 'contacts.email', 'channels.type as channel_type', 'channels.name as channel_name'])
        .where('conversations.id', '=', id).executeTakeFirst();
      if (!c) throw Errors.notFound();
      const last = await lastInboundAt(tx, c.contact_id, c.channel_id);
      return {
        ...c,
        replyWindow: c.channel_type === 'whatsapp'
          ? { freeFormAllowed: isWithinServiceWindow(last), closesAt: windowClosesAt(last) }
          : { freeFormAllowed: true, closesAt: null },
      };
    });
  });

  app.get('/v1/conversations/:id/messages', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
    return withTenant(db, tenantOf(req), async (tx) => {
      let query = tx.selectFrom('messages').selectAll().where('conversation_id', '=', id).orderBy('id', 'desc').limit(q.limit);
      if (q.before) query = query.where('id', '<', q.before);
      const messages = (await query.execute()).reverse();
      const attachments = messages.length
        ? await tx.selectFrom('message_attachments')
            .select(['id', 'message_id', 'mime_type', 'size_bytes', 'filename', sql<boolean>`storage_key is not null`.as('ready')])
            .where('message_id', 'in', messages.map((m) => m.id)).execute()
        : [];
      return messages.map((m) => ({ ...m, attachments: attachments.filter((a) => a.message_id === m.id) }));
    });
  });

  app.post('/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const r = await queueAgentMessage(db, tenantOf(req), id, parse(SendMessageBody, req.body));
    return reply.status(r.created ? 201 : 200).send(r.message);
  });
}
