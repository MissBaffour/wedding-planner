import { uuidv7 } from '@kasadesk/shared';
import { sql } from 'kysely';
import type { Tx } from '../../platform/db/index.ts';
import type { ChannelType } from '../../platform/db/schema.ts';

export interface ContactFrom {
  handle: string;
  phoneE164?: string;
  email?: string;
  name?: string;
  profile?: Record<string, unknown>;
}

/**
 * Contact unification:
 *   1. known identity on this channel (handle)  -> that contact
 *   2. same phone number on any channel         -> that contact, and remember the new handle
 *   3. otherwise                                -> new contact
 * Race-safe: concurrent first messages from the same person end on the same contact
 * (unique indexes + ON CONFLICT, then re-read).
 */
export async function resolveContact(
  tx: Tx,
  businessId: string,
  channel: { id: string; type: ChannelType },
  from: ContactFrom,
): Promise<{ contactId: string; created: boolean }> {
  const byHandle = async () =>
    tx.selectFrom('contact_identities')
      .innerJoin('contacts', 'contacts.id', 'contact_identities.contact_id')
      .select(['contacts.id', 'contacts.merged_into_id', 'contacts.display_name'])
      .where('contact_identities.channel_id', '=', channel.id)
      .where('contact_identities.handle', '=', from.handle)
      .executeTakeFirst();

  const known = await byHandle();
  if (known) {
    const contactId = known.merged_into_id ?? known.id;
    await tx.updateTable('contacts')
      .set({ last_seen_at: new Date(), ...(from.name && !known.display_name ? { display_name: from.name } : {}) })
      .where('id', '=', contactId).execute();
    return { contactId, created: false };
  }

  let contactId: string | undefined;
  let created = false;
  if (from.phoneE164) {
    const byPhone = await tx.selectFrom('contacts').select(['id', 'display_name'])
      .where('phone_e164', '=', from.phoneE164).where('merged_into_id', 'is', null).executeTakeFirst();
    if (byPhone) {
      contactId = byPhone.id;
      await tx.updateTable('contacts')
        .set({ last_seen_at: new Date(), ...(from.name && !byPhone.display_name ? { display_name: from.name } : {}) })
        .where('id', '=', contactId).execute();
    }
  }
  if (!contactId) {
    const id = uuidv7();
    const inserted = await tx.insertInto('contacts')
      .values({
        id, business_id: businessId, display_name: from.name ?? null, phone_e164: from.phoneE164 ?? null,
        email: from.email ?? null, attributes: '{}',
      })
      .onConflict((oc) => oc.expression(sql`business_id, phone_e164`).where('phone_e164', 'is not', null).where('merged_into_id', 'is', null).doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      contactId = inserted.id;
      created = true;
    } else {
      // Lost a race with another message from the same phone.
      contactId = (await tx.selectFrom('contacts').select('id').where('phone_e164', '=', from.phoneE164!)
        .where('merged_into_id', 'is', null).executeTakeFirstOrThrow()).id;
    }
  }

  const ident = await tx.insertInto('contact_identities')
    .values({
      id: uuidv7(), business_id: businessId, contact_id: contactId, channel_id: channel.id, channel_type: channel.type,
      handle: from.handle, profile: JSON.stringify({ ...(from.name && { name: from.name }), ...from.profile }),
    })
    .onConflict((oc) => oc.columns(['business_id', 'channel_id', 'handle']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!ident) {
    const again = await byHandle();
    return { contactId: again!.merged_into_id ?? again!.id, created: false };
  }
  return { contactId, created };
}

/**
 * Merge `fromId` into `intoId` (e.g. a web visitor gives a phone number that
 * already belongs to a WhatsApp customer). Everything moves to `intoId`;
 * `fromId` is kept as a tombstone pointing at it.
 */
export async function mergeContacts(tx: Tx, fromId: string, intoId: string): Promise<void> {
  if (fromId === intoId) return;
  // Only one open conversation per contact per channel: resolve the source's duplicates first.
  await sql`
    update conversations c set status = 'resolved', resolved_at = now()
     where c.contact_id = ${fromId} and c.status <> 'resolved'
       and exists (select 1 from conversations o where o.contact_id = ${intoId} and o.channel_id = c.channel_id and o.status <> 'resolved')`.execute(tx);
  await sql`update conversations set contact_id = ${intoId} where contact_id = ${fromId}`.execute(tx);
  await sql`update messages set contact_id = ${intoId} where contact_id = ${fromId}`.execute(tx);
  await sql`update contact_identities set contact_id = ${intoId} where contact_id = ${fromId}`.execute(tx);
  await sql`update contact_consent_events set contact_id = ${intoId} where contact_id = ${fromId}`.execute(tx);
  await sql`insert into contact_tags (business_id, contact_id, tag_id)
              select business_id, ${intoId}, tag_id from contact_tags where contact_id = ${fromId}
            on conflict do nothing`.execute(tx);
  await sql`delete from contact_tags where contact_id = ${fromId}`.execute(tx);
  await sql`update payment_requests set contact_id = ${intoId} where contact_id = ${fromId}`.execute(tx);
  await sql`update sales set contact_id = ${intoId} where contact_id = ${fromId}`.execute(tx);
  await sql`
    update contacts i set
      display_name = coalesce(i.display_name, f.display_name),
      email = coalesce(i.email, f.email),
      first_seen_at = least(i.first_seen_at, f.first_seen_at),
      last_seen_at = greatest(i.last_seen_at, f.last_seen_at)
      from contacts f where i.id = ${intoId} and f.id = ${fromId}`.execute(tx);
  await tx.updateTable('contacts').set({ merged_into_id: intoId, phone_e164: null }).where('id', '=', fromId).execute();
}

export async function recordConsent(
  tx: Tx, businessId: string, contactId: string,
  c: { status: 'granted' | 'withdrawn'; purpose: 'service' | 'marketing'; source: string; evidence?: Record<string, unknown>; recordedBy?: string | null },
) {
  await tx.insertInto('contact_consent_events').values({
    id: uuidv7(), business_id: businessId, contact_id: contactId, status: c.status, purpose: c.purpose,
    source: c.source, evidence: JSON.stringify(c.evidence ?? {}), recorded_by: c.recordedBy ?? null,
  }).execute();
  if (c.purpose === 'service' || c.status === 'withdrawn') {
    await tx.updateTable('contacts').set({ consent_status: c.status }).where('id', '=', contactId).execute();
  }
}
