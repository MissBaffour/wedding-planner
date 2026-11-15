import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, makeTestApp, signup, waitFor, type SignedUp, type TestCtx } from '../helpers.ts';

/**
 * Real browser test: built widget.js on a "shop" page (different origin) talking to the real API + workers.
 * Requires `pnpm --filter @kasadesk/widget build` first.
 */
const WIDGET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../widget/dist/widget.js');
const require = createRequire(import.meta.url);
let chromium: any;
try { chromium = require('playwright').chromium; } catch { chromium = null; }
const ready = existsSync(WIDGET) && chromium;

describe.skipIf(!ready)('widget in a real browser', () => {
  let ctx: TestCtx;
  let shop: Server;
  let browser: any;
  let apiUrl = '';
  let shopUrl = '';
  let owner: SignedUp;
  let key = '';

  beforeAll(async () => {
    ctx = await makeTestApp({ workers: true });
    apiUrl = await ctx.app.listen({ port: 0, host: '127.0.0.1' });
    shop = createServer((req, res) => {
      if (req.url === '/widget.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(readFileSync(WIDGET)); }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body><h1>Auntie Ama's Shop</h1>
        <script src="/widget.js" data-kasadesk-key="${key}" data-kasadesk-api="${apiUrl}" async></script></body></html>`);
    });
    await new Promise<void>((r) => shop.listen(0, '127.0.0.1', r));
    shopUrl = `http://127.0.0.1:${(shop.address() as AddressInfo).port}`;

    owner = await signup(ctx.app);
    const ch = await api(ctx.app, owner.token).post('/v1/channels/webchat', { name: 'Site', allowedOrigins: [shopUrl], title: 'Chat with Ama', greeting: 'Akwaaba!' });
    key = ch.json().external_id;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise((r) => shop?.close(r));
    await ctx?.close();
  });

  const inbox = async () => (await api(ctx.app, owner.token).get('/v1/conversations')).json() as any[];

  it('visitor chats, agent replies, and messages typed offline are delivered exactly once', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }); // phone-sized
    const page = await context.newPage();
    await page.goto(shopUrl);
    const w = page.locator('#kasadesk-widget');
    await w.getByRole('button', { name: 'Open chat' }).click();
    await w.getByText('Akwaaba!').waitFor();
    // widget.js is served WITHOUT a charset (like many CDNs): non-ASCII UI text must still render.
    expect(await w.getByRole('button', { name: 'Close chat' }).first().textContent()).toBe('\u00d7');

    const box = w.getByLabel('Type your message');
    await box.fill('Do you have kente in blue?');
    await box.press('Enter');
    await w.getByRole('button', { name: 'Skip' }).click(); // contact form is optional

    const convs = await waitFor(async () => { const c = await inbox(); return c.length ? c : null; }, 10_000, 'conversation in inbox');
    expect(convs[0].last_message_preview).toBe('Do you have kente in blue?');

    await api(ctx.app, owner.token).post(`/v1/conversations/${convs[0].id}/messages`, { clientId: randomUUID(), text: 'Yes! Blue and gold, GH₵ 450.' });
    await w.getByText('Yes! Blue and gold, GH₵ 450.').waitFor({ timeout: 10_000 });

    // Network drops: the visitor keeps typing.
    await context.setOffline(true);
    await box.fill('Can you deliver to Tema?');
    await box.press('Enter');
    await w.getByText('Sending…').waitFor();
    await page.waitForTimeout(1500);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await waitFor(async () => {
      const msgs = (await api(ctx.app, owner.token).get(`/v1/conversations/${convs[0].id}/messages`)).json();
      return msgs.some((m: any) => m.body === 'Can you deliver to Tema?') ? msgs : null;
    }, 15_000, 'offline message delivered');
    await page.waitForTimeout(1000);
    const msgs = (await api(ctx.app, owner.token).get(`/v1/conversations/${convs[0].id}/messages`)).json();
    expect(msgs.filter((m: any) => m.body === 'Can you deliver to Tema?')).toHaveLength(1);
    await expect(w.getByText('Sending…').count()).resolves.toBe(0);

    // Reload: the same visitor and history come back from the stored token.
    await page.reload();
    await w.getByRole('button', { name: 'Open chat' }).click();
    await w.getByText('Yes! Blue and gold, GH₵ 450.').waitFor({ timeout: 10_000 });
    expect(await inbox()).toHaveLength(1);
    await context.close();
  }, 60_000);

  it('does not load on a site that is not allowed', async () => {
    const page = await browser.newPage();
    await page.route('**/*', (route: any) => route.continue());
    await page.goto(`${apiUrl}/healthz`); // different origin from the allowed shop
    await page.setContent(`<script src="${shopUrl}/widget.js" data-kasadesk-key="${key}" data-kasadesk-api="${apiUrl}"></script>`);
    await page.waitForTimeout(1500);
    expect(await page.locator('#kasadesk-widget').evaluate((el: Element) => el.shadowRoot?.childElementCount ?? 0)).toBe(0);
    await page.close();
  }, 30_000);
});
