/** Channel-agnostic message shapes. Every adapter converts provider payloads into these. */
export type ChannelType = 'whatsapp' | 'instagram' | 'messenger' | 'sms' | 'email' | 'webchat';

export type InboundKind =
  | 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker'
  | 'location' | 'contact_card' | 'interactive' | 'reaction' | 'unsupported';

export interface InboundAttachment {
  providerMediaId?: string;
  url?: string;
  mimeType: string;
  filename?: string;
  isVoiceNote?: boolean;
}

export interface NormalizedInbound {
  channelType: ChannelType;
  /** Provider account the message arrived on (phone_number_id, page id, widget key...). Routes to the tenant. */
  channelExternalId: string;
  /** Idempotency key. */
  providerMessageId: string;
  from: { handle: string; phoneE164?: string; email?: string; name?: string; profile?: Record<string, unknown> };
  kind: InboundKind;
  /** Plain-text rendering for the inbox and search. */
  body?: string;
  payload: Record<string, unknown>;
  attachments?: InboundAttachment[];
  replyToProviderId?: string;
  /** Provider timestamp (ISO-8601). */
  timestamp: string;
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface NormalizedStatus {
  channelType: ChannelType;
  channelExternalId: string;
  providerMessageId: string;
  status: DeliveryStatus;
  timestamp: string;
  error?: { code: string; title?: string; details?: string };
  /** Provider billing info if supplied (e.g. WhatsApp `pricing`). Stored as-is for metering. */
  pricing?: Record<string, unknown>;
}

const STATUS_RANK: Record<string, number> = { received: 0, queued: 1, sending: 2, sent: 3, delivered: 4, read: 5, failed: 6 };

/**
 * Webhook receipts arrive out of order (delivered before sent is common).
 * Only move forward; `failed` wins unless the message was already delivered or read.
 */
export function shouldApplyStatus(current: string, next: DeliveryStatus): boolean {
  if (next === 'failed') return current !== 'delivered' && current !== 'read' && current !== 'failed';
  if (current === 'failed') return false;
  return (STATUS_RANK[next] ?? 0) > (STATUS_RANK[current] ?? 0);
}
