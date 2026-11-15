import type { ChannelAdapter, SendResult } from '../core/types.ts';

/** Web chat: the widget fetches messages from us, so storing the message IS delivery. */
export class WebchatAdapter implements ChannelAdapter {
  readonly type = 'webchat' as const;
  async send(): Promise<SendResult> {
    return { providerMessageId: null, status: 'delivered' };
  }
}
