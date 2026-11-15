import type { ChannelType } from '../../../platform/db/schema.ts';

export interface OutboundContent {
  kind: 'text' | 'template' | 'image' | 'audio' | 'video' | 'document';
  text?: string;
  template?: { name: string; language: string; components: unknown[] };
  media?: { providerMediaId?: string; link?: string; caption?: string; filename?: string };
  replyToProviderId?: string;
}

export interface SendTarget {
  channelId: string;
  channelType: ChannelType;
  externalId: string;
  credentials: Record<string, string>;
  /** Recipient handle on the channel (wa_id, visitor id, PSID...). */
  to: string;
}

export interface SendResult {
  providerMessageId: string | null;
  /** Some channels (web chat) are delivered as soon as we store them. */
  status: 'sent' | 'delivered';
}

export interface ChannelAdapter {
  readonly type: ChannelType;
  send(target: SendTarget, content: OutboundContent): Promise<SendResult>;
}

/** Thrown by adapters. `retryable` decides between backoff-retry and permanent failure. */
export class ChannelError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}
