import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signMetaBody } from '../../src/modules/channels/whatsapp/signature.ts';
import { withTenant } from '../../src/platform/db/index.ts';
import { FakeGraph, waText, waWebhook } from '../fake-graph.ts';
import { api, makeTestApp, signup, waitFor, type SignedUp, type TestCtx } from '../helpers.ts';

let ctx: TestCtx;
let graph: FakeGraph;
let pnSeq = 900000;
const nextPnid = () => String(++pnSeq) + String(Date.now()).slice(-6);

beforeAll(async () => {
  graph = await new FakeGraph().start();
  ctx = await makeTestApp({ env: { META_GRAPH_BASE_URL: graph.url }, workers: true });
});
afterAll(async () => { await ctx.close(); await graph.stop(); });
beforeEach(() => graph.reset());

const postWebhook = (body: unknown, opts: { secret?: string; path?: string } = {}) => {
  const raw = JSON.stringify(body);
  return ctx.app.inject({
    method: 'POST', url: opts.path ?? '/webhooks/whatsapp', payload: raw,
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaBody(raw, opts.secret ?? 'platform-app-secret') },
  });
};

async function connected(mode: 'platform' | 'byo' = 'platform') {
  const owner = await signup(ctx.app);
  const pnid = nextPnid();
  const res = await api(ctx.app, owner.token).post('/v1/channels/whatsapp', {
    name: 'Main line', phoneNumberId: pnid, wabaId: '100200300', accessToken: 'EAAG-test-token-1234567890', mode,
    ...(mode === 'byo' && { appSecret: 'their-own-app-secret' }),
  });
  if (res.statusCode !== 201) throw new Error(res.body);
  return { owner, pnid, channel: res.json() };
}

const convOf = async (o: SignedUp) => (await api(ctx.app, o.token).get('/v1/conversations')).json() as any[];
const messagesOf = async (o: SignedUp, convId: string) => (await api(ctx.app, o.token).get(`/v1/conversations/${convId}/messages`)).json() as any[];

async function receiveText(pnid: string, from: string, text: string, id = `wamid.in.${randomUUID()}`) {
  const res = await postWebhook(waWebhook(pnid, waText(from, id, text)));
  expect(res.statusCode).toBe(200);
  return id;
}

describe('webhook verification and signatures', () => {
  it('answers the Meta verification challenge only with the right token', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=platform-verify-token&hub.challenge=12345' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('12345');
    const bad = await ctx.app.inject({ method: 'GET', url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1' });
    expect(bad.statusCode).toBe(403);
  });

  it('rejects unsigned or wrongly signed bodies and stores nothing', async () => {
    const before = await ctx.sys.selectFrom('webhook_events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect((await postWebhook(waWebhook('1', waText('233200000000', 'wamid.bad', 'x')), { secret: 'wrong' })).statusCode).toBe(401);
    const unsigned = await ctx.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: { object: 'whatsapp_business_account' } });
    expect(unsigned.statusCode).toBe(401);
    const after = await ctx.sys.selectFrom('webhook_events').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});

describe('connecting a number', () => {
  it('checks the number with Graph, subscribes the app, encrypts the token and syncs templates', async () => {
    graph.templates = [
      { id: '1', name: 'order_ready', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} is ready.' }] },
      { id: '2', name: 'promo', language: 'en', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Sale!' }] },
    ];
    const { owner, pnid, channel } = await connected();
    expect(channel.config).toMatchObject({ mode: 'platform', verifiedName: 'Test Shop' });
    expect(graph.calls.map((c) => `${c.method} ${c.path.replace(/v[\d.]+/, 'vX')}`)).toEqual(expect.arrayContaining([
      `GET /vX/${pnid}`, 'POST /vX/100200300/subscribed_apps',
    ]));
    const row = await ctx.sys.selectFrom('channels').select(['credentials_enc']).where('id', '=', channel.id).executeTakeFirstOrThrow();
    expect(row.credentials_enc!.toString('utf8')).not.toContain('EAAG-test-token');

    const templates = await waitFor(async () => {
      const t = (await api(ctx.app, owner.token).get(`/v1/channels/${channel.id}/templates`)).json();
      return t.length === 2 ? t : null;
    }, 8000, 'template sync');
    expect(templates.map((t: any) => [t.name, t.category, t.status])).toEqual([['order_ready', 'utility', 'APPROVED'], ['promo', 'marketing', 'PENDING']]);
    // Never return credentials
    const list = (await api(ctx.app, owner.token).get('/v1/channels')).json();
    expect(JSON.stringify(list)).not.toMatch(/credentials|EAAG/);
  });

  it('refuses a number already connected elsewhere and reports Graph errors', async () => {
    const { pnid } = await connected();
    const other = await signup(ctx.app);
    const dup = await api(ctx.app, other.token).post('/v1/channels/whatsapp', { name: 'x', phoneNumberId: pnid, wabaId: '100200300', accessToken: 'EAAG-test-token-1234567890' });
    expect(dup.json().error.code).toBe('already_connected');

    graph.failNext(/\/\d+$/, 400, { error: { message: 'Invalid OAuth access token', code: 190 } });
    const bad = await api(ctx.app, other.token).post('/v1/channels/whatsapp', { name: 'x', phoneNumberId: nextPnid(), wabaId: '1002003', accessToken: 'EAAG-bad-token-1234567890' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('whatsapp_check_failed');
  });

  it('agents cannot connect channels', async () => {
    const { owner } = await connected();
    // owner invites an agent quickly via the helper flow
    await api(ctx.app, owner.token).post('/v1/invitations', { email: `agent-${randomUUID()}@x.com` });
    const token = new URL(ctx.notifier.last('invitation')!.data.url as string).searchParams.get('token')!;
    const agent = (await api(ctx.app).post('/v1/invitations/accept', { token, password: 'agent-password-1', fullName: 'Yaw' })).json();
    const res = await api(ctx.app, agent.accessToken).post('/v1/channels/webchat', { name: 'Site' });
    expect(res.statusCode).toBe(403);
  });
});

describe('inbound messages', () => {
  it('creates contact, conversation and message; webhook retries are no-ops', async () => {
    const { owner, pnid } = await connected();
    const body = waWebhook(pnid, waText('233241112222', 'wamid.in.dup-1', 'Please do you have size 42?', 'Akosua'));
    expect((await postWebhook(body)).statusCode).toBe(200);
    expect((await postWebhook(body)).statusCode).toBe(200); // identical retry
    // Same message id inside a different body (Meta can batch differently on retry)
    const rebatched = waWebhook(pnid, { ...waText('233241112222', 'wamid.in.dup-1', 'Please do you have size 42?', 'Akosua'), statuses: [] });
    expect((await postWebhook(rebatched)).statusCode).toBe(200);

    const convs = await waitFor(async () => { const c = await convOf(owner); return c.length ? c : null; }, 8000, 'conversation');
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ display_name: 'Akosua', phone_e164: '+233241112222', channel_type: 'whatsapp', unread_count: 1, status: 'open' });
    await new Promise((r) => setTimeout(r, 300));
    const msgs = await messagesOf(owner, convs[0].id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ direction: 'inbound', body: 'Please do you have size 42?', status: 'received' });
  });

  it('a second message joins the same conversation; another number gets its own', async () => {
    const { owner, pnid } = await connected();
    await receiveText(pnid, '233243334444', 'Hello');
    await receiveText(pnid, '233243334444', 'Are you there?');
    await receiveText(pnid, '233205556666', 'Price of rice?');
    const convs = await waitFor(async () => {
      const c = await convOf(owner);
      return c.length === 2 && c.some((x) => x.unread_count === 2) ? c : null;
    }, 8000, 'two conversations');
    expect(convs.find((c) => c.phone_e164 === '+233243334444').unread_count).toBe(2);
  });

  it('inbound messages are stored even when the account is read-only, but agents cannot reply', async () => {
    const { owner, pnid } = await connected();
    await ctx.sys.updateTable('businesses').set({ trial_ends_at: new Date(Date.now() - 86_400_000) }).where('id', '=', owner.businessId).execute();
    await receiveText(pnid, '233247778888', 'Hello?');
    const convs = await waitFor(async () => { const c = await convOf(owner); return c.length ? c : null; }, 8000, 'conversation');
    const send = await api(ctx.app, owner.token).post(`/v1/conversations/${convs[0].id}/messages`, { clientId: randomUUID(), text: 'Hi' });
    expect(send.statusCode).toBe(402);
  });

  it('messages for unknown numbers or other tenants never leak', async () => {
    const a = await connected();
    const b = await connected();
    await receiveText(a.pnid, '233249990000', 'For A only');
    await receiveText('000999888777', '233249990000', 'Nobody owns this number');
    await waitFor(async () => (await convOf(a.owner)).length === 1, 8000, 'A conversation');
    await waitFor(async () => {
      const ev = await ctx.sys.selectFrom('webhook_events').select('processed_at').where('payload', '@>', JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '000999888777' } } }] }] }) as never).executeTakeFirst();
      return ev?.processed_at;
    }, 8000, 'unknown-number event processed');
    expect(await convOf(b.owner)).toHaveLength(0);
  });

  it('downloads voice notes into storage and serves them to agents', async () => {
    const { owner, pnid } = await connected();
    await postWebhook(waWebhook(pnid, {
      contacts: [{ profile: { name: 'Kwabena' }, wa_id: '233540001111' }],
      messages: [{ from: '233540001111', id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'audio', audio: { id: 'media-voice-1', mime_type: 'audio/ogg; codecs=opus', voice: true } }],
    }));
    const convs = await waitFor(async () => { const c = await convOf(owner); return c.length ? c : null; }, 8000, 'conversation');
    const att = await waitFor(async () => {
      const m = await messagesOf(owner, convs[0].id);
      return m[0]?.attachments?.[0]?.ready ? m[0].attachments[0] : null;
    }, 8000, 'media download');
    const file = await api(ctx.app, owner.token).get(`/v1/attachments/${att.id}/content`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('audio/ogg');
    expect(file.rawPayload.equals(graph.mediaBytes)).toBe(true);
    // Another business cannot fetch it
    const other = await signup(ctx.app);
    expect((await api(ctx.app, other.token).get(`/v1/attachments/${att.id}/content`)).statusCode).toBe(404);
  });
});

describe('sending', () => {
  async function openConversation() {
    const c = await connected();
    await receiveText(c.pnid, '233261234000', 'I want to order');
    const convs = await waitFor(async () => { const x = await convOf(c.owner); return x.length ? x : null; }, 8000, 'conversation');
    return { ...c, convId: convs[0].id as string };
  }

  it('sends a reply inside the 24h window and records wamid, sent status and first response', async () => {
    const { owner, pnid, convId } = await openConversation();
    const clientId = randomUUID();
    const res = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId, text: 'Yes! GH₵ 120, delivery today.' });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('queued');

    const sent = await waitFor(async () => {
      const m = (await messagesOf(owner, convId)).find((x) => x.client_id === clientId);
      return m?.status === 'sent' ? m : null;
    }, 8000, 'message sent');
    expect(sent.provider_message_id).toMatch(/^wamid\.out\./);
    const call = graph.sends()[0]!;
    expect(call.path).toContain(`/${pnid}/messages`);
    expect(call.auth).toBe('Bearer EAAG-test-token-1234567890');
    expect(call.body).toMatchObject({ messaging_product: 'whatsapp', to: '233261234000', type: 'text', text: { body: 'Yes! GH₵ 120, delivery today.' } });
    const conv = (await api(ctx.app, owner.token).get(`/v1/conversations/${convId}`)).json();
    expect(conv.first_response_at).toBeTruthy();
    expect(conv.replyWindow.freeFormAllowed).toBe(true);

    // Receipts arrive out of order: read before delivered. Final state is read.
    await postWebhook(waWebhook(pnid, { statuses: [{ id: sent.provider_message_id, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '233261234000' }] }));
    await postWebhook(waWebhook(pnid, { statuses: [{ id: sent.provider_message_id, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000) - 1), recipient_id: '233261234000', pricing: { billable: false, category: 'service' } }] }));
    const read = await waitFor(async () => {
      const m = (await messagesOf(owner, convId)).find((x) => x.client_id === clientId);
      return m?.status === 'read' && m.payload.pricing ? m : null;
    }, 8000, 'read receipt');
    expect(read.read_at).toBeTruthy();
    expect(read.payload.pricing).toEqual({ billable: false, category: 'service' });
  });

  it('the same clientId is sent exactly once (offline retries from the PWA)', async () => {
    const { owner, convId } = await openConversation();
    const clientId = randomUUID();
    const a = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId, text: 'Once' });
    const b = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId, text: 'Once' });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(b.json().id).toBe(a.json().id);
    await waitFor(async () => graph.sends().length === 1, 8000, 'one send');
    await new Promise((r) => setTimeout(r, 400));
    expect(graph.sends()).toHaveLength(1);
  });

  it('outside 24h: free text is refused (422) and approved templates are sent', async () => {
    graph.templates = [{ id: '9', name: 'order_ready', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}} is ready.' }] },
      { id: '10', name: 'draft', language: 'en', status: 'REJECTED', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }] }];
    const { owner, convId, channel } = await openConversation();
    await waitFor(async () => (await api(ctx.app, owner.token).get(`/v1/channels/${channel.id}/templates`)).json().length === 2, 8000, 'templates');
    await withTenant(ctx.db, { businessId: owner.businessId, userId: null }, (tx) =>
      tx.updateTable('messages').set({ created_at: new Date(Date.now() - 25 * 3600_000) }).where('conversation_id', '=', convId).execute());

    const text = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: randomUUID(), text: 'Hello again' });
    expect(text.statusCode).toBe(422);
    expect(text.json().error.code).toBe('outside_service_window');
    expect((await api(ctx.app, owner.token).get(`/v1/conversations/${convId}`)).json().replyWindow.freeFormAllowed).toBe(false);

    const wrongParams = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: randomUUID(), template: { name: 'order_ready', language: 'en', bodyParams: ['Esi'] } });
    expect(wrongParams.json().error.code).toBe('template_params_invalid');
    const rejected = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: randomUUID(), template: { name: 'draft', language: 'en' } });
    expect(rejected.json().error.code).toBe('template_not_approved');

    const ok = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: randomUUID(), template: { name: 'order_ready', language: 'en', bodyParams: ['Esi', '#204'] } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().body).toBe('Hi Esi, order #204 is ready.');
    const call = await waitFor(async () => graph.sends()[0], 8000, 'template send');
    expect(call.body).toMatchObject({
      type: 'template',
      template: { name: 'order_ready', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Esi' }, { type: 'text', text: '#204' }] }] },
    });
  });

  it('retries temporary errors, fails permanently on policy errors', async () => {
    const { owner, convId } = await openConversation();
    graph.failNext(/\/messages$/, 500, { error: { message: 'Service temporarily unavailable', code: 131016 } }, 2);
    const okId = randomUUID();
    await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: okId, text: 'Retry me' });
    const ok = await waitFor(async () => {
      const m = (await messagesOf(owner, convId)).find((x) => x.client_id === okId);
      return m?.status === 'sent' ? m : null;
    }, 10_000, 'sent after retries');
    expect(ok.attempts).toBe(3);

    graph.failNext(/\/messages$/, 400, { error: { message: 'Message failed to send because more than 24 hours have passed', code: 131047 } });
    const badId = randomUUID();
    await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: badId, text: 'Too late' });
    const failed = await waitFor(async () => {
      const m = (await messagesOf(owner, convId)).find((x) => x.client_id === badId);
      return m?.status === 'failed' ? m : null;
    }, 8000, 'permanent failure');
    expect(failed).toMatchObject({ error_code: '131047', attempts: 1 });
  });

  it('a failed delivery receipt marks the message failed with the reason', async () => {
    const { owner, pnid, convId } = await openConversation();
    const clientId = randomUUID();
    await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId, text: 'Hi' });
    const sent = await waitFor(async () => (await messagesOf(owner, convId)).find((x) => x.client_id === clientId && x.provider_message_id), 8000, 'sent');
    await postWebhook(waWebhook(pnid, { statuses: [{ id: sent.provider_message_id, status: 'failed', timestamp: String(Math.floor(Date.now() / 1000)), errors: [{ code: 131026, title: 'Message undeliverable' }] }] }));
    const failed = await waitFor(async () => {
      const m = (await messagesOf(owner, convId)).find((x) => x.client_id === clientId);
      return m?.status === 'failed' ? m : null;
    }, 8000, 'failed receipt');
    expect(failed).toMatchObject({ error_code: '131026', error_message: 'Message undeliverable' });
  });

  it('disconnecting wipes the token, ignores new webhooks and blocks sending', async () => {
    const { owner, pnid, convId, channel } = await openConversation();
    expect((await api(ctx.app, owner.token).delete(`/v1/channels/${channel.id}`)).statusCode).toBe(204);
    const row = await ctx.sys.selectFrom('channels').select(['credentials_enc', 'status']).where('id', '=', channel.id).executeTakeFirstOrThrow();
    expect(row).toEqual({ credentials_enc: null, status: 'disconnected' });
    const send = await api(ctx.app, owner.token).post(`/v1/conversations/${convId}/messages`, { clientId: randomUUID(), text: 'x' });
    expect(send.json().error.code).toBe('channel_inactive');
    await receiveText(pnid, '233261234000', 'After disconnect');
    await new Promise((r) => setTimeout(r, 500));
    expect(await messagesOf(owner, convId)).toHaveLength(1);
  });
});

describe('bring-your-own Meta app', () => {
  it('gives a per-channel webhook URL + verify token and checks that app\'s signature', async () => {
    const { owner, pnid, channel } = await connected('byo');
    expect(channel.webhookUrl).toMatch(/^http:\/\/api\.test\/webhooks\/whatsapp\/wa_/);
    expect(channel.verifyToken).toBeTruthy();
    expect(graph.calls.some((c) => c.path.endsWith('/subscribed_apps'))).toBe(false); // their app, their subscription
    const path = new URL(channel.webhookUrl).pathname;

    const verify = await ctx.app.inject({ method: 'GET', url: `${path}?hub.mode=subscribe&hub.verify_token=${channel.verifyToken}&hub.challenge=abc` });
    expect(verify.body).toBe('abc');
    expect((await ctx.app.inject({ method: 'GET', url: `${path}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=abc` })).statusCode).toBe(403);

    // Platform secret is not valid for this URL
    expect((await postWebhook(waWebhook(pnid, waText('233271112222', 'wamid.byo.x', 'hi')), { path })).statusCode).toBe(401);
    expect((await postWebhook(waWebhook(pnid, waText('233271112222', 'wamid.byo.1', 'Hello from BYO')), { path, secret: 'their-own-app-secret' })).statusCode).toBe(200);
    await waitFor(async () => (await convOf(owner)).length === 1, 8000, 'byo conversation');

    // The BYO secret cannot inject messages for another tenant's number.
    const victim = await connected();
    await postWebhook(waWebhook(victim.pnid, waText('233271112222', 'wamid.byo.evil', 'spoof')), { path, secret: 'their-own-app-secret' });
    await new Promise((r) => setTimeout(r, 500));
    expect(await convOf(victim.owner)).toHaveLength(0);
  });
});

describe('template status webhook', () => {
  it('re-syncs templates when Meta approves one', async () => {
    graph.templates = [{ id: '5', name: 'welcome', language: 'en', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Welcome' }] }];
    const { owner, channel } = await connected();
    await waitFor(async () => (await api(ctx.app, owner.token).get(`/v1/channels/${channel.id}/templates`)).json()[0]?.status === 'PENDING', 8000, 'pending');
    graph.templates = [{ ...graph.templates[0], status: 'APPROVED' }];
    await postWebhook({ object: 'whatsapp_business_account', entry: [{ id: '100200300', changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED', message_template_id: 5, message_template_name: 'welcome', message_template_language: 'en' } }] }] });
    await waitFor(async () => (await api(ctx.app, owner.token).get(`/v1/channels/${channel.id}/templates`)).json()[0]?.status === 'APPROVED', 8000, 'approved');
  });
});

describe('concurrency', () => {
  it('receipts processed in parallel never move a message backwards', async () => {
    const c = await connected();
    await receiveText(c.pnid, '233269990001', 'hi');
    const convs = await waitFor(async () => { const x = await convOf(c.owner); return x.length ? x : null; }, 8000, 'conversation');
    for (let round = 0; round < 5; round++) {
      const clientId = randomUUID();
      await api(ctx.app, c.owner.token).post(`/v1/conversations/${convs[0].id}/messages`, { clientId, text: `m${round}` });
      const sent = await waitFor(async () => (await messagesOf(c.owner, convs[0].id)).find((x) => x.client_id === clientId && x.status === 'sent'), 8000, 'sent');
      const ts = String(Math.floor(Date.now() / 1000));
      await Promise.all(['read', 'delivered', 'sent', 'delivered'].map((status) =>
        postWebhook(waWebhook(c.pnid, { statuses: [{ id: sent.provider_message_id, status, timestamp: ts, recipient_id: '233269990001', nonce: randomUUID() }] }))));
      const final = await waitFor(async () => {
        const m = (await messagesOf(c.owner, convs[0].id)).find((x) => x.client_id === clientId);
        const pending = await ctx.sys.selectFrom('webhook_events').select('id').where('processed_at', 'is', null).executeTakeFirst();
        return !pending ? m : null;
      }, 8000, 'receipts processed');
      expect(final.status).toBe('read');
    }
  });
});
