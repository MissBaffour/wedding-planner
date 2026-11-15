import { ChannelError, type ChannelAdapter, type OutboundContent, type SendResult, type SendTarget } from '../core/types.ts';
import { WhatsAppClient, type GraphConfig } from './client.ts';

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = 'whatsapp' as const;
  constructor(private readonly graph: GraphConfig) {}

  client(credentials: Record<string, string>) {
    if (!credentials.accessToken) throw new ChannelError('channel has no access token', 'no_credentials', false);
    return new WhatsAppClient(this.graph, credentials.accessToken);
  }

  async send(target: SendTarget, content: OutboundContent): Promise<SendResult> {
    const msg = toGraphMessage(target.to, content);
    const res = await this.client(target.credentials).sendMessage(target.externalId, msg);
    const id = res.messages?.[0]?.id;
    if (!id) throw new ChannelError('WhatsApp accepted the request but returned no message id', 'no_message_id', false);
    return { providerMessageId: id, status: 'sent' };
  }
}

export function toGraphMessage(to: string, c: OutboundContent): Record<string, unknown> {
  const context = c.replyToProviderId ? { context: { message_id: c.replyToProviderId } } : {};
  switch (c.kind) {
    case 'text':
      return { to, type: 'text', text: { body: c.text ?? '', preview_url: /https?:\/\//.test(c.text ?? '') }, ...context };
    case 'template':
      return {
        to, type: 'template',
        template: { name: c.template!.name, language: { code: c.template!.language }, components: c.template!.components },
      };
    case 'image':
    case 'audio':
    case 'video':
    case 'document': {
      const m = c.media ?? {};
      const media: Record<string, unknown> = m.providerMediaId ? { id: m.providerMediaId } : { link: m.link };
      if (m.caption && c.kind !== 'audio') media.caption = m.caption;
      if (m.filename && c.kind === 'document') media.filename = m.filename;
      return { to, type: c.kind, [c.kind]: media, ...context };
    }
  }
}
