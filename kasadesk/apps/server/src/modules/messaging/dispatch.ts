import { shouldApplyStatus, uuidv7 } from '@kasadesk/shared';
import { sql } from 'kysely';
import type { Keyring } from '../../platform/crypto.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import type { ChannelType } from '../../platform/db/schema.ts';
import { emit } from '../../platform/outbox.ts';
import type { OutboundJob } from '../../platform/queues.ts';
import { decryptCredentials } from '../channels/core/repo.ts';
import { ChannelError, type ChannelAdapter, type OutboundContent } from '../channels/core/types.ts';

/** A message left in 'sending' longer than this (worker crashed mid-send) may be claimed again. */
export const SEND_LEASE_SECONDS = 120;

export interface DispatchDeps {
  db: DB;
  keyring: Keyring;
  adapters: Partial<Record<ChannelType, ChannelAdapter>>;
}

export type DispatchOutcome = 'sent' | 'skipped' | 'failed' | 'retry';

/**
 * Worker side of sending. Steps:
 *  1. claim the message (queued -> sending) in a short transaction
 *  2. call the provider OUTSIDE any transaction
 *  3. record the result
 * Retryable errors go back to 'queued' and are re-thrown so BullMQ backs off;
 * permanent errors (e.g. outside the 24h window, invalid number) mark the message failed.
 */
export async function dispatchMessage(deps: DispatchDeps, job: OutboundJob, isLastAttempt: boolean): Promise<DispatchOutcome> {
  const ctx = { businessId: job.businessId, userId: null };

  const claimed = await withTenant(deps.db, ctx, async (tx) => {
    const m = await tx.updateTable('messages')
      .set((eb) => ({ status: 'sending', claimed_at: new Date(), attempts: eb('attempts', '+', 1) }))
      .where('id', '=', job.messageId)
      .where((eb) => eb.or([
        eb('status', '=', 'queued'),
        eb.and([eb('status', '=', 'sending'), eb('claimed_at', '<', sql<Date>`now() - make_interval(secs => ${SEND_LEASE_SECONDS})`)]),
      ]))
      .returningAll()
      .executeTakeFirst();
    if (!m) return null;
    const channel = await tx.selectFrom('channels').selectAll().where('id', '=', m.channel_id).executeTakeFirstOrThrow();
    const ident = await tx.selectFrom('contact_identities').select('handle')
      .where('contact_id', '=', m.contact_id).where('channel_id', '=', m.channel_id).orderBy('created_at').executeTakeFirst();
    const contact = await tx.selectFrom('contacts').select(['phone_e164']).where('id', '=', m.contact_id).executeTakeFirstOrThrow();
    const replyTo = m.reply_to_id
      ? (await tx.selectFrom('messages').select('provider_message_id').where('id', '=', m.reply_to_id).executeTakeFirst())?.provider_message_id
      : null;
    return { m, channel, handle: ident?.handle ?? (channel.type === 'whatsapp' ? contact.phone_e164?.replace('+', '') : undefined), replyTo };
  });
  if (!claimed) return 'skipped';

  const { m, channel, handle, replyTo } = claimed;
  const fail = (code: string, message: string) => recordFailure(deps.db, ctx, m.id, m.conversation_id, code, message);

  const adapter = deps.adapters[channel.type];
  if (!adapter) return fail('channel_unsupported', `No adapter for ${channel.type}`).then(() => 'failed' as const);
  if (channel.status !== 'active') return fail('channel_inactive', 'Channel is disconnected').then(() => 'failed' as const);
  if (!handle) return fail('no_recipient', 'Customer has no address on this channel').then(() => 'failed' as const);

  const payload = m.payload as Record<string, unknown>;
  const content: OutboundContent = m.kind === 'template'
    ? { kind: 'template', template: payload.template as OutboundContent['template'] }
    : { kind: 'text', text: m.body ?? '', replyToProviderId: replyTo ?? undefined };

  try {
    const result = await adapter.send(
      { channelId: channel.id, channelType: channel.type, externalId: channel.external_id, credentials: decryptCredentials(deps.keyring, channel), to: handle },
      content,
    );
    await withTenant(deps.db, ctx, async (tx) => {
      const now = new Date();
      // A receipt webhook may already have advanced the status; never move backwards.
      const current = await tx.selectFrom('messages').select('status').where('id', '=', m.id).forUpdate().executeTakeFirstOrThrow();
      const advance = current.status === 'sending' || shouldApplyStatus(current.status, result.status);
      await tx.updateTable('messages').set({
        provider_message_id: result.providerMessageId,
        claimed_at: null, error_code: null, error_message: null,
        sent_at: now,
        ...(advance && { status: result.status }),
        ...(result.status === 'delivered' && { delivered_at: now }),
      }).where('id', '=', m.id).execute();

      const conv = await tx.updateTable('conversations')
        .set({ last_outbound_at: now })
        .where('id', '=', m.conversation_id)
        .returning(['first_response_at'])
        .executeTakeFirstOrThrow();
      if (m.sender_type === 'agent' && !conv.first_response_at) {
        await tx.updateTable('conversations').set({ first_response_at: now }).where('id', '=', m.conversation_id).execute();
        await tx.insertInto('conversation_events').values({
          id: uuidv7(), business_id: job.businessId, conversation_id: m.conversation_id, type: 'first_response',
          actor_type: 'agent', actor_id: m.sender_id, data: '{}',
        }).execute();
      }
      await emit(tx, job.businessId, 'message.updated', { conversationId: m.conversation_id, messageId: m.id, status: result.status });
    });
    return 'sent';
  } catch (err) {
    const ce = err instanceof ChannelError ? err : new ChannelError((err as Error).message, 'internal', true);
    if (ce.retryable && !isLastAttempt) {
      await withTenant(deps.db, ctx, (tx) =>
        tx.updateTable('messages')
          .set({ status: 'queued', claimed_at: null, error_code: ce.code, error_message: ce.message.slice(0, 500) })
          .where('id', '=', m.id).execute());
      throw ce; // BullMQ retries with exponential backoff
    }
    await fail(ce.code, ce.message);
    return 'failed';
  }
}

async function recordFailure(db: DB, ctx: { businessId: string; userId: null }, messageId: string, conversationId: string, code: string, message: string) {
  await withTenant(db, ctx, async (tx) => {
    await tx.updateTable('messages')
      .set({ status: 'failed', failed_at: new Date(), claimed_at: null, error_code: code, error_message: message.slice(0, 500) })
      .where('id', '=', messageId).execute();
    await emit(tx, ctx.businessId, 'message.updated', { conversationId, messageId, status: 'failed', errorCode: code });
  });
}
