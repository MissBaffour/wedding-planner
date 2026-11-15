import { shouldApplyStatus } from '@kasadesk/shared';
import { describe, expect, it } from 'vitest';
import { toGraphMessage } from '../../src/modules/channels/whatsapp/adapter.ts';
import { parseWhatsAppWebhook } from '../../src/modules/channels/whatsapp/parse.ts';
import { signMetaBody, verifyMetaSignature } from '../../src/modules/channels/whatsapp/signature.ts';
import { buildTemplateSend, templateParamCounts } from '../../src/modules/channels/whatsapp/templates.ts';
import { isWithinServiceWindow } from '../../src/modules/channels/whatsapp/window.ts';
import { waWebhook } from '../fake-graph.ts';

const PNID = '111222333';
const msg = (m: Record<string, unknown>) => waWebhook(PNID, { contacts: [{ profile: { name: 'Ama' }, wa_id: '233241234567' }], messages: [{ from: '233241234567', id: 'wamid.X', timestamp: '1767225600', ...m }] });

describe('parseWhatsAppWebhook', () => {
  it('text message with contact name and phone', () => {
    const r = parseWhatsAppWebhook(msg({ type: 'text', text: { body: 'Ɛte sɛn? How much?' } }));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({
      channelExternalId: PNID, providerMessageId: 'wamid.X', kind: 'text', body: 'Ɛte sɛn? How much?',
      from: { handle: '233241234567', phoneE164: '+233241234567', name: 'Ama' },
      timestamp: '2026-01-01T00:00:00.000Z',
    });
  });

  it('voice note and image with caption become attachments', () => {
    const voice = parseWhatsAppWebhook(msg({ type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true } })).messages[0]!;
    expect(voice.kind).toBe('audio');
    expect(voice.attachments).toEqual([{ providerMediaId: 'media-1', mimeType: 'audio/ogg; codecs=opus', filename: undefined, isVoiceNote: true }]);
    const img = parseWhatsAppWebhook(msg({ type: 'image', image: { id: 'media-2', mime_type: 'image/jpeg', caption: 'This one' } })).messages[0]!;
    expect(img).toMatchObject({ kind: 'image', body: 'This one' });
  });

  it('location, interactive reply, template button, reaction, reply context', () => {
    expect(parseWhatsAppWebhook(msg({ type: 'location', location: { latitude: 5.6, longitude: -0.18, name: 'Makola' } })).messages[0])
      .toMatchObject({ kind: 'location', body: '📍 Makola', payload: { latitude: 5.6, longitude: -0.18 } });
    expect(parseWhatsAppWebhook(msg({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes please' } } })).messages[0])
      .toMatchObject({ kind: 'interactive', body: 'Yes please' });
    expect(parseWhatsAppWebhook(msg({ type: 'button', button: { text: 'Track order', payload: 'TRACK' } })).messages[0])
      .toMatchObject({ kind: 'interactive', body: 'Track order' });
    expect(parseWhatsAppWebhook(msg({ type: 'reaction', reaction: { message_id: 'wamid.Y', emoji: '👍' } })).messages[0])
      .toMatchObject({ kind: 'reaction', body: '👍', payload: { reactedToProviderId: 'wamid.Y' } });
    expect(parseWhatsAppWebhook(msg({ type: 'text', text: { body: 'ok' }, context: { from: '233', id: 'wamid.ORIG' } })).messages[0]!.replyToProviderId).toBe('wamid.ORIG');
  });

  it('unknown types are kept as unsupported, not dropped', () => {
    const r = parseWhatsAppWebhook(msg({ type: 'unsupported', errors: [{ code: 131051 }] }));
    expect(r.messages[0]).toMatchObject({ kind: 'unsupported' });
  });

  it('statuses with errors and pricing', () => {
    const r = parseWhatsAppWebhook(waWebhook(PNID, {
      statuses: [
        { id: 'wamid.A', status: 'delivered', timestamp: '1767225600', recipient_id: '233', pricing: { billable: true, category: 'utility' } },
        { id: 'wamid.B', status: 'failed', timestamp: '1767225600', errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: 'more than 24 hours' } }] },
        { id: 'wamid.C', status: 'deleted', timestamp: '1767225600' },
      ],
    }));
    expect(r.statuses).toHaveLength(2);
    expect(r.statuses[0]).toMatchObject({ status: 'delivered', pricing: { billable: true, category: 'utility' } });
    expect(r.statuses[1]!.error).toEqual({ code: '131047', title: 'Re-engagement message', details: 'more than 24 hours' });
  });

  it('template status updates and foreign payloads', () => {
    const r = parseWhatsAppWebhook({ object: 'whatsapp_business_account', entry: [{ id: '999', changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 77, message_template_name: 'order_ready', message_template_language: 'en' } }] }] });
    expect(r.templateUpdates).toEqual([{ wabaId: '999', providerTemplateId: '77', name: 'order_ready', language: 'en', event: 'APPROVED', reason: undefined }]);
    expect(parseWhatsAppWebhook({ object: 'page', entry: [] })).toEqual({ messages: [], statuses: [], templateUpdates: [] });
  });
});

describe('signature', () => {
  const body = Buffer.from('{"a":1}');
  it('accepts a correct HMAC and rejects anything else', () => {
    expect(verifyMetaSignature(body, signMetaBody(body, 's3cret'), 's3cret')).toBe(true);
    expect(verifyMetaSignature(body, signMetaBody(body, 'other'), 's3cret')).toBe(false);
    expect(verifyMetaSignature(Buffer.from('{"a":2}'), signMetaBody(body, 's3cret'), 's3cret')).toBe(false);
    expect(verifyMetaSignature(body, undefined, 's3cret')).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=zz', 's3cret')).toBe(false);
    expect(verifyMetaSignature(body, signMetaBody(body, ''), '')).toBe(false);
  });
});

describe('24-hour window', () => {
  const now = new Date('2026-06-01T12:00:00Z');
  it('is open for 24 hours after the last customer message', () => {
    expect(isWithinServiceWindow(new Date('2026-05-31T12:00:01Z'), now)).toBe(true);
    expect(isWithinServiceWindow(new Date('2026-05-31T12:00:00Z'), now)).toBe(false);
    expect(isWithinServiceWindow(null, now)).toBe(false);
  });
});

describe('templates', () => {
  const components = [
    { type: 'HEADER', format: 'TEXT', text: 'Order {{1}}' },
    { type: 'BODY', text: 'Hi {{1}}, your order of {{2}} is ready for pickup.' },
    { type: 'FOOTER', text: 'Reply STOP to opt out' },
  ];
  it('counts parameters and builds send components + preview', () => {
    expect(templateParamCounts(components)).toEqual({ header: 1, body: 2 });
    const r = buildTemplateSend(components, { headerParams: ['#204'], bodyParams: ['Esi', 'GH₵ 350'] });
    expect(r.components).toEqual([
      { type: 'header', parameters: [{ type: 'text', text: '#204' }] },
      { type: 'body', parameters: [{ type: 'text', text: 'Esi' }, { type: 'text', text: 'GH₵ 350' }] },
    ]);
    expect(r.preview).toBe('Order #204\nHi Esi, your order of GH₵ 350 is ready for pickup.\nReply STOP to opt out');
  });
  it('rejects the wrong number of parameters or blanks', () => {
    expect(() => buildTemplateSend(components, { headerParams: ['#1'], bodyParams: ['Esi'] })).toThrow(/body needs 2/);
    expect(() => buildTemplateSend(components, { headerParams: ['#1'], bodyParams: ['Esi', ' '] })).toThrow(/empty/);
    expect(() => buildTemplateSend([{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hi' }], {})).not.toThrow();
  });
});

describe('Graph message mapping', () => {
  it('text, reply, template and media', () => {
    expect(toGraphMessage('233', { kind: 'text', text: 'see https://x.gh', replyToProviderId: 'wamid.1' }))
      .toEqual({ to: '233', type: 'text', text: { body: 'see https://x.gh', preview_url: true }, context: { message_id: 'wamid.1' } });
    expect(toGraphMessage('233', { kind: 'template', template: { name: 'hello', language: 'en', components: [] } }))
      .toEqual({ to: '233', type: 'template', template: { name: 'hello', language: { code: 'en' }, components: [] } });
    expect(toGraphMessage('233', { kind: 'document', media: { providerMediaId: 'm1', caption: 'Invoice', filename: 'inv.pdf' } }))
      .toEqual({ to: '233', type: 'document', document: { id: 'm1', caption: 'Invoice', filename: 'inv.pdf' } });
  });
});

describe('receipt ordering', () => {
  it('never moves backwards; failed does not override delivered/read', () => {
    expect(shouldApplyStatus('sent', 'delivered')).toBe(true);
    expect(shouldApplyStatus('read', 'delivered')).toBe(false);
    expect(shouldApplyStatus('sending', 'read')).toBe(true);
    expect(shouldApplyStatus('sent', 'failed')).toBe(true);
    expect(shouldApplyStatus('delivered', 'failed')).toBe(false);
    expect(shouldApplyStatus('failed', 'delivered')).toBe(false);
  });
});
