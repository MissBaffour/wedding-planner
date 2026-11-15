import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeGraph, waText, waWebhook } from '../fake-graph.ts';
import { signMetaBody } from '../../src/modules/channels/whatsapp/signature.ts';
import { api, makeTestApp, signup, waitFor, type SignedUp, type TestCtx } from '../helpers.ts';

let ctx: TestCtx;
let graph: FakeGraph;
beforeAll(async () => {
  graph = await new FakeGraph().start();
  ctx = await makeTestApp({ env: { META_GRAPH_BASE_URL: graph.url }, workers: true });
});
afterAll(async () => { await ctx.close(); await graph.stop(); });

const SITE = 'https://shop.example.gh';

async function widget(allowedOrigins: string[] = [SITE]) {
  const owner = await signup(ctx.app);
  const res = await api(ctx.app, owner.token).post('/v1/channels/webchat', { name: 'Website', allowedOrigins, greeting: 'Akwaaba! How can we help?' });
  expect(res.statusCode).toBe(201);
  return { owner, channel: res.json(), key: res.json().external_id as string };
}

const wapi = (token?: string, origin = SITE) => {
  const headers: Record<string, string> = { origin, ...(token && { authorization: `Bearer ${token}` }) };
  return {
    session: (widgetKey: string, visitorToken?: string) => ctx.app.inject({ method: 'POST', url: '/widget/v1/session', headers, payload: { widgetKey, visitorToken } }),
    send: (text: string, clientId = randomUUID()) => ctx.app.inject({ method: 'POST', url: '/widget/v1/messages', headers, payload: { clientId, text } }),
    poll: (after?: string, seen = false) => ctx.app.inject({ method: 'GET', url: `/widget/v1/messages?${after ? `after=${after}&` : ''}${seen ? 'seen=1' : ''}`, headers }),
    identify: (body: Record<string, unknown>) => ctx.app.inject({ method: 'POST', url: '/widget/v1/identify', headers, payload: body }),
  };
};

const inbox = async (o: SignedUp) => (await api(ctx.app, o.token).get('/v1/conversations')).json() as any[];

describe('web chat widget API', () => {
  it('creating a widget returns an embed snippet', async () => {
    const { channel, key } = await widget();
    expect(key).toMatch(/^wc_/);
    expect(channel.embedSnippet).toContain(`data-kasadesk-key="${key}"`);
    expect(channel.embedSnippet).toContain('data-kasadesk-api="http://api.test"');
  });

  it('only allowed origins may open a session', async () => {
    const { key } = await widget();
    expect((await wapi(undefined, 'https://evil.example').session(key)).statusCode).toBe(403);
    const ok = await wapi().session(key);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().widget).toMatchObject({ greeting: 'Akwaaba! How can we help?', askForContact: true });
    expect((await wapi().session('wc_doesnotexist')).statusCode).toBe(404);
  });

  it('visitor messages reach the inbox; retries do not duplicate; agent replies come back', async () => {
    const { owner, key } = await widget();
    const s = (await wapi().session(key)).json();
    const v = wapi(s.visitorToken);
    const clientId = randomUUID();
    expect((await v.send('Do you deliver to Kumasi?', clientId)).statusCode).toBe(201);
    expect((await v.send('Do you deliver to Kumasi?', clientId)).statusCode).toBe(200); // offline retry

    const convs = await inbox(owner);
    expect(convs).toHaveLength(1);
    expect(convs[0]).toMatchObject({ channel_type: 'webchat', last_message_preview: 'Do you deliver to Kumasi?', unread_count: 1 });

    // Agent replies; web chat has no 24h window
    const reply = await api(ctx.app, owner.token).post(`/v1/conversations/${convs[0].id}/messages`, { clientId: randomUUID(), text: 'Yes, GH₵ 40 by VIP bus.' });
    expect(reply.statusCode).toBe(201);
    await waitFor(async () => (await api(ctx.app, owner.token).get(`/v1/conversations/${convs[0].id}/messages`)).json().some((m: any) => m.status === 'delivered'), 8000, 'delivered');

    const all = (await v.poll()).json().messages;
    expect(all.map((m: any) => [m.from, m.text])).toEqual([['visitor', 'Do you deliver to Kumasi?'], ['business', 'Yes, GH₵ 40 by VIP bus.']]);
    expect(all[0].clientId).toBe(clientId);
    // Cursor: nothing new after the last id
    expect((await v.poll(all[1].id)).json().messages).toEqual([]);
    // Seen marks the reply read for the agent
    await v.poll(undefined, true);
    const msgs = (await api(ctx.app, owner.token).get(`/v1/conversations/${convs[0].id}/messages`)).json();
    expect(msgs.find((m: any) => m.direction === 'outbound').status).toBe('read');
  });

  it('a returning visitor keeps their conversation (same token)', async () => {
    const { owner, key } = await widget();
    const s1 = (await wapi().session(key)).json();
    await wapi(s1.visitorToken).send('first visit');
    const s2 = (await wapi().session(key, s1.visitorToken)).json();
    expect(s2.visitorId).toBe(s1.visitorId);
    await wapi(s2.visitorToken).send('came back');
    expect((await inbox(owner))[0].unread_count).toBe(2);
  });

  it('identify with a phone already known from WhatsApp links the visitor to that customer', async () => {
    const { owner, key } = await widget();
    // The customer first wrote on WhatsApp
    const pnid = `77${Date.now()}`;
    await api(ctx.app, owner.token).post('/v1/channels/whatsapp', { name: 'WA', phoneNumberId: pnid, wabaId: '5551112', accessToken: 'EAAG-test-token-1234567890' });
    const raw = JSON.stringify(waWebhook(pnid, waText('233244445555', `wamid.${randomUUID()}`, 'Hi from WhatsApp', 'Abena Owusu')));
    await ctx.app.inject({ method: 'POST', url: '/webhooks/whatsapp', payload: raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaBody(raw, 'platform-app-secret') } });
    await waitFor(async () => (await inbox(owner)).length === 1, 8000, 'whatsapp conversation');

    const s = (await wapi().session(key)).json();
    const v = wapi(s.visitorToken);
    await v.send('Hello from the website');
    expect((await v.identify({ name: 'Abena', phone: '024 444 5555' })).statusCode).toBe(400); // consent required
    const id = await v.identify({ name: 'Abena', phone: '024 444 5555', consent: true });
    expect(id.json()).toEqual({ ok: true, linkedToExistingCustomer: true });

    const convs = await inbox(owner);
    expect(convs).toHaveLength(2);
    expect(new Set(convs.map((c) => c.contact_id)).size).toBe(1); // one customer, two channels
    expect(convs.every((c) => c.phone_e164 === '+233244445555')).toBe(true);
    const consent = await ctx.sys.selectFrom('contact_consent_events').selectAll().where('contact_id', '=', convs[0].contact_id).execute();
    expect(consent[0]).toMatchObject({ status: 'granted', purpose: 'service', source: 'webchat_form' });
    // The visitor still sees their chat after the merge
    expect((await v.poll()).json().messages.map((m: any) => m.text)).toEqual(['Hello from the website']);
  });

  it('rejects forged tokens and tokens for disconnected widgets', async () => {
    const { owner, key, channel } = await widget();
    const s = (await wapi().session(key)).json();
    const forged = s.visitorToken.slice(0, -4) + 'AAAA';
    expect((await wapi(forged).send('x')).statusCode).toBe(401);
    expect((await wapi().send('x')).statusCode).toBe(401);
    await api(ctx.app, owner.token).delete(`/v1/channels/${channel.id}`);
    expect((await wapi(s.visitorToken).send('x')).statusCode).toBe(404);
  });

  it('CORS: /widget is open to any site, the agent API is not', async () => {
    const pre = (url: string) => ctx.app.inject({ method: 'OPTIONS', url, headers: { origin: 'https://random-shop.gh', 'access-control-request-method': 'POST' } });
    expect((await pre('/widget/v1/messages')).headers['access-control-allow-origin']).toBe('https://random-shop.gh');
    expect((await pre('/v1/conversations')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('publishes realtime events through the outbox', async () => {
    const { owner, key } = await widget([]);
    const sub = new Redis(ctx.config.REDIS_URL);
    const got: any[] = [];
    await sub.subscribe(`kd:rt:${owner.businessId}`);
    sub.on('message', (_c, m) => got.push(JSON.parse(m)));
    const s = (await wapi(undefined, 'https://anything.gh').session(key)).json();
    await wapi(s.visitorToken, 'https://anything.gh').send('ping');
    await waitFor(async () => got.find((e) => e.topic === 'message.created'), 5000, 'realtime event');
    expect(got.map((e) => e.topic)).toEqual(expect.arrayContaining(['message.created', 'conversation.updated']));
    sub.disconnect();
  });
});
