import { shouldApplyStatus, uuidv7, type NormalizedInbound, type NormalizedStatus } from '@kasadesk/shared';
import { sql } from 'kysely';
import type { Tx } from '../../platform/db/index.ts';
import type { ChannelType } from '../../platform/db/schema.ts';
import { emit } from '../../platform/outbox.ts';
import { resolveContact } from '../contacts/service.ts';

export interface IngestResult {
  duplicate: boolean;
  messageId?: string;
  conversationId?: string;
  contactId?: string;
  newConversation?: boolean;
}

export const preview = (body: string | undefined | null, kind: string) =>
  body?.trim() ? body.trim().slice(0, 140) : `[${kind.replace('_', ' ')}]`;

/**
 * Store one normalized inbound message (inside the tenant transaction).
 * Idempotent on (channel_id, provider_message_id): a provider retry is a no-op.
 */
export async function ingestInbound(
  tx: Tx,
  businessId: string,
  channel: { id: string; type: ChannelType },
  n: NormalizedInbound,
): Promise<IngestResult> {
  const existing = await tx.selectFrom('messages').select('id')
    .where('channel_id', '=', channel.id).where('provider_message_id', '=', n.providerMessageId).executeTakeFirst();
  if (existing) return { duplicate: true, messageId: existing.id };

  const { contactId } = await resolveContact(tx, businessId, channel, n.from);
  const contact = await tx.selectFrom('contacts').select(['blocked']).where('id', '=', contactId).executeTakeFirstOrThrow();

  // Find or open the live conversation (race-safe with the partial unique index).
  let newConversation = false;
  let conv = await tx.selectFrom('conversations').select(['id', 'status'])
    .where('contact_id', '=', contactId).where('channel_id', '=', channel.id).where('status', '<>', 'resolved')
    .executeTakeFirst();
  if (!conv) {
    const now = new Date();
    const inserted = await tx.insertInto('conversations')
      .values({ id: uuidv7(), business_id: businessId, contact_id: contactId, channel_id: channel.id, queued_at: now })
      .onConflict((oc) => oc.expression(sql`business_id, contact_id, channel_id`).where('status', '<>', 'resolved').doNothing())
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (inserted) {
      conv = inserted;
      newConversation = true;
    } else {
      conv = await tx.selectFrom('conversations').select(['id', 'status'])
        .where('contact_id', '=', contactId).where('channel_id', '=', channel.id).where('status', '<>', 'resolved')
        .executeTakeFirstOrThrow();
    }
  }

  let replyToId: string | null = null;
  if (n.replyToProviderId) {
    replyToId = (await tx.selectFrom('messages').select('id')
      .where('channel_id', '=', channel.id).where('provider_message_id', '=', n.replyToProviderId).executeTakeFirst())?.id ?? null;
  }

  const messageId = uuidv7();
  const inserted = await tx.insertInto('messages')
    .values({
      id: messageId, business_id: businessId, conversation_id: conv.id, contact_id: contactId, channel_id: channel.id,
      direction: 'inbound', sender_type: 'contact', kind: n.kind, body: n.body ?? null,
      payload: JSON.stringify({ ...n.payload, providerTimestamp: n.timestamp }),
      provider_message_id: n.providerMessageId, reply_to_id: replyToId, status: 'received',
    })
    .onConflict((oc) => oc.expression(sql`channel_id, provider_message_id`).where('provider_message_id', 'is not', null).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return { duplicate: true };

  for (const a of n.attachments ?? []) {
    const attachmentId = uuidv7();
    await tx.insertInto('message_attachments').values({
      id: attachmentId, business_id: businessId, message_id: messageId, mime_type: a.mimeType,
      filename: a.filename ?? null, provider_media_id: a.providerMediaId ?? null,
    }).execute();
    if (a.providerMediaId) await emit(tx, businessId, 'media.download', { attachmentId });
  }

  const now = new Date();
  await tx.updateTable('conversations')
    .set((eb) => ({
      last_inbound_at: now,
      last_message_at: now,
      last_message_preview: preview(n.body, n.kind),
      unread_count: eb('unread_count', '+', 1),
      // A customer reply wakes snoozed conversations and moves "waiting on customer" back to open.
      ...(conv!.status === 'snoozed' || conv!.status === 'pending' ? { status: 'open' as const, snoozed_until: null } : {}),
    }))
    .where('id', '=', conv.id)
    .execute();

  if (newConversation) {
    await tx.insertInto('conversation_events').values([
      { id: uuidv7(), business_id: businessId, conversation_id: conv.id, type: 'created', data: JSON.stringify({ channel: channel.type }) },
      { id: uuidv7(), business_id: businessId, conversation_id: conv.id, type: 'queued', data: '{}' },
    ]).execute();
  }

  await emit(tx, businessId, 'message.created', { conversationId: conv.id, messageId, direction: 'inbound', blocked: contact.blocked });
  await emit(tx, businessId, 'conversation.updated', { conversationId: conv.id, newConversation });
  return { duplicate: false, messageId, conversationId: conv.id, contactId, newConversation };
}

export class StatusBeforeSendError extends Error {}

/**
 * Apply a delivery receipt. Out-of-order receipts never move a message backwards.
 * If the receipt is for a message we have not finished recording (the webhook
 * beat our own DB write), throw so the job retries shortly.
 */
export async function applyStatus(tx: Tx, businessId: string, channelId: string, s: NormalizedStatus): Promise<boolean> {
  // FOR UPDATE: concurrent receipts for the same message (read + delivered processed in parallel)
  // must decide one after the other, or the later commit could move the status backwards.
  const m = await tx.selectFrom('messages').select(['id', 'status', 'conversation_id', 'sent_at'])
    .where('channel_id', '=', channelId).where('provider_message_id', '=', s.providerMessageId)
    .forUpdate().executeTakeFirst();
  if (!m) {
    const ageMs = Date.now() - new Date(s.timestamp).getTime();
    if (ageMs < 2 * 60_000) throw new StatusBeforeSendError(`status for unknown message ${s.providerMessageId}`);
    return false; // e.g. sent from another app on the same number
  }
  const at = new Date(s.timestamp);
  const pricingPatch = s.pricing ? sql`payload || ${JSON.stringify({ pricing: s.pricing })}::jsonb` : sql`payload`;
  if (!shouldApplyStatus(m.status, s.status)) {
    if (s.pricing) await tx.updateTable('messages').set({ payload: pricingPatch as never }).where('id', '=', m.id).execute();
    return false;
  }
  await tx.updateTable('messages')
    .set({
      status: s.status,
      payload: pricingPatch as never,
      ...(s.status === 'sent' && { sent_at: at }),
      ...(s.status === 'delivered' && { delivered_at: at, sent_at: m.sent_at ?? at }),
      ...(s.status === 'read' && { read_at: at, sent_at: m.sent_at ?? at }),
      ...(s.status === 'failed' && { failed_at: at, error_code: s.error?.code ?? null, error_message: [s.error?.title, s.error?.details].filter(Boolean).join(': ') || null }),
    })
    .where('id', '=', m.id)
    .execute();
  await emit(tx, businessId, 'message.updated', { conversationId: m.conversation_id, messageId: m.id, status: s.status });
  return true;
}
