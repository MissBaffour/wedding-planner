/**
 * WhatsApp Cloud API webhook payload -> normalized messages/statuses.
 *
 * Shape (object = 'whatsapp_business_account'):
 *   entry[].changes[] { field: 'messages', value: { metadata: { phone_number_id }, contacts[], messages[], statuses[] } }
 *   entry[].changes[] { field: 'message_template_status_update', value: { event, message_template_id, message_template_name, message_template_language, reason } }
 *
 * Unknown types become 'unsupported' instead of being dropped, so agents still see that something arrived.
 */
import type { InboundAttachment, NormalizedInbound, NormalizedStatus } from '@kasadesk/shared';

type Any = Record<string, any>;

export interface TemplateStatusUpdate {
  wabaId: string;
  providerTemplateId: string;
  name: string;
  language: string;
  event: string;
  reason?: string;
}

export interface ParsedWhatsAppWebhook {
  messages: NormalizedInbound[];
  statuses: NormalizedStatus[];
  templateUpdates: TemplateStatusUpdate[];
}

const toIso = (unixSeconds: unknown) => {
  const n = Number(unixSeconds);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
};

/** wa_id is normally the phone number in international format without '+'. */
const phoneFromWaId = (waId: string) => (/^\d{8,15}$/.test(waId) ? `+${waId}` : undefined);

const MEDIA_TYPES = ['image', 'audio', 'video', 'document', 'sticker'] as const;

export function parseWhatsAppWebhook(body: Any): ParsedWhatsAppWebhook {
  const out: ParsedWhatsAppWebhook = { messages: [], statuses: [], templateUpdates: [] };
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry as Any[]) {
    for (const change of (entry.changes ?? []) as Any[]) {
      const value: Any = change.value ?? {};

      if (change.field === 'message_template_status_update') {
        out.templateUpdates.push({
          wabaId: String(entry.id),
          providerTemplateId: String(value.message_template_id ?? ''),
          name: String(value.message_template_name ?? ''),
          language: String(value.message_template_language ?? ''),
          event: String(value.event ?? ''),
          reason: value.reason ?? undefined,
        });
        continue;
      }
      if (change.field !== 'messages') continue;

      const phoneNumberId = String(value.metadata?.phone_number_id ?? '');
      if (!phoneNumberId) continue;
      const names = new Map<string, string>();
      for (const c of (value.contacts ?? []) as Any[]) {
        if (c?.wa_id && c?.profile?.name) names.set(String(c.wa_id), String(c.profile.name));
      }

      for (const m of (value.messages ?? []) as Any[]) {
        if (!m?.id || !m?.from) continue;
        const from = String(m.from);
        const n: NormalizedInbound = {
          channelType: 'whatsapp',
          channelExternalId: phoneNumberId,
          providerMessageId: String(m.id),
          from: { handle: from, phoneE164: phoneFromWaId(from), name: names.get(from) },
          kind: 'unsupported',
          payload: { type: m.type },
          timestamp: toIso(m.timestamp),
          replyToProviderId: m.context?.id ? String(m.context.id) : undefined,
        };
        mapContent(m, n);
        out.messages.push(n);
      }

      for (const s of (value.statuses ?? []) as Any[]) {
        if (!s?.id || !['sent', 'delivered', 'read', 'failed'].includes(s.status)) continue;
        const err = Array.isArray(s.errors) ? s.errors[0] : undefined;
        out.statuses.push({
          channelType: 'whatsapp',
          channelExternalId: phoneNumberId,
          providerMessageId: String(s.id),
          status: s.status,
          timestamp: toIso(s.timestamp),
          error: err ? { code: String(err.code), title: err.title ?? err.message, details: err.error_data?.details } : undefined,
          pricing: s.pricing ?? undefined,
        });
      }
    }
  }
  return out;
}

function mapContent(m: Any, n: NormalizedInbound) {
  const type = String(m.type ?? '');
  if (type === 'text') {
    n.kind = 'text';
    n.body = String(m.text?.body ?? '');
    return;
  }
  if ((MEDIA_TYPES as readonly string[]).includes(type)) {
    const media: Any = m[type] ?? {};
    const att: InboundAttachment = {
      providerMediaId: media.id ? String(media.id) : undefined,
      mimeType: String(media.mime_type ?? 'application/octet-stream'),
      filename: media.filename ?? undefined,
      isVoiceNote: type === 'audio' ? Boolean(media.voice) : undefined,
    };
    n.kind = type as NormalizedInbound['kind'];
    n.body = media.caption ? String(media.caption) : undefined;
    n.attachments = [att];
    n.payload = { type, voice: att.isVoiceNote ?? undefined };
    return;
  }
  if (type === 'location') {
    const l: Any = m.location ?? {};
    n.kind = 'location';
    n.payload = { latitude: l.latitude, longitude: l.longitude, name: l.name, address: l.address };
    n.body = ['📍', l.name, l.address].filter(Boolean).join(' ') || `📍 ${l.latitude}, ${l.longitude}`;
    return;
  }
  if (type === 'contacts') {
    n.kind = 'contact_card';
    n.payload = { contacts: m.contacts };
    const first: Any = m.contacts?.[0] ?? {};
    n.body = `👤 ${first.name?.formatted_name ?? 'Contact'} ${first.phones?.[0]?.phone ?? ''}`.trim();
    return;
  }
  if (type === 'interactive') {
    const i: Any = m.interactive ?? {};
    const reply: Any = i.button_reply ?? i.list_reply ?? {};
    n.kind = 'interactive';
    n.payload = { interactiveType: i.type, id: reply.id, title: reply.title };
    n.body = reply.title ? String(reply.title) : undefined;
    return;
  }
  if (type === 'button') {
    // Quick-reply button tapped on a template message.
    n.kind = 'interactive';
    n.payload = { interactiveType: 'template_button', payload: m.button?.payload, title: m.button?.text };
    n.body = m.button?.text ? String(m.button.text) : undefined;
    return;
  }
  if (type === 'reaction') {
    n.kind = 'reaction';
    n.payload = { emoji: m.reaction?.emoji ?? null, reactedToProviderId: m.reaction?.message_id };
    n.body = m.reaction?.emoji ? String(m.reaction.emoji) : undefined;
    return;
  }
  n.kind = 'unsupported';
  n.payload = { type, errors: m.errors };
  n.body = undefined;
}
