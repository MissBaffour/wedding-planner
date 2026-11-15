import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GraphCall { method: string; path: string; auth?: string; body: any }

/**
 * A local stand-in for graph.facebook.com used by integration tests.
 * It implements only the endpoints KasaDesk calls, with response shapes from
 * Meta's Cloud API reference. Tests can queue failures.
 */
export class FakeGraph {
  readonly calls: GraphCall[] = [];
  templates: Record<string, unknown>[] = [];
  mediaBytes = Buffer.from('OggS-fake-voice-note');
  private failures: { match: RegExp; status: number; body: unknown }[] = [];
  private seq = 0;
  private server!: Server;
  url = '';

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
  reset() {
    this.calls.length = 0;
    this.failures = [];
  }
  /** Fail the next `times` requests whose path matches. */
  failNext(match: RegExp, status: number, body: unknown, times = 1) {
    for (let i = 0; i < times; i++) this.failures.push({ match, status, body });
  }
  sends() {
    return this.calls.filter((c) => c.method === 'POST' && /\/messages$/.test(c.path) && !c.body?.status);
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: any = raw;
    if ((req.headers['content-type'] ?? '').includes('json')) body = raw ? JSON.parse(raw) : {};
    const path = (req.url ?? '').split('?')[0]!;
    this.calls.push({ method: req.method!, path, auth: req.headers.authorization, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    const fi = this.failures.findIndex((f) => f.match.test(path));
    if (fi >= 0) {
      const f = this.failures.splice(fi, 1)[0]!;
      return send(f.status, f.body);
    }
    if (!req.headers.authorization?.startsWith('Bearer ')) return send(401, { error: { message: 'no token', code: 190 } });

    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = path.match(/^\/v[\d.]+\/(\d+)\/messages$/))) {
      if (body.status === 'read') return send(200, { success: true });
      return send(200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.out.${++this.seq}` }] });
    }
    if (req.method === 'POST' && (m = path.match(/^\/v[\d.]+\/(\d+)\/subscribed_apps$/))) return send(200, { success: true });
    if (req.method === 'GET' && (m = path.match(/^\/v[\d.]+\/(\d+)\/message_templates$/))) return send(200, { data: this.templates, paging: {} });
    if (req.method === 'GET' && (m = path.match(/^\/media-download\/(.+)$/))) {
      res.writeHead(200, { 'content-type': 'audio/ogg', 'content-length': String(this.mediaBytes.length) });
      return res.end(this.mediaBytes);
    }
    if (req.method === 'GET' && (m = path.match(/^\/v[\d.]+\/(media-[\w-]+)$/))) {
      return send(200, { id: m[1], url: `${this.url}/media-download/${m[1]}`, mime_type: 'audio/ogg; codecs=opus', file_size: this.mediaBytes.length });
    }
    if (req.method === 'GET' && (m = path.match(/^\/v[\d.]+\/(\d+)$/))) {
      return send(200, { id: m[1], display_phone_number: '+233 30 000 0001', verified_name: 'Test Shop', quality_rating: 'GREEN' });
    }
    return send(404, { error: { message: `fake graph: no route ${req.method} ${path}`, code: 100 } });
  }
}

/** Build a WhatsApp Cloud API webhook body. */
export function waWebhook(phoneNumberId: string, value: Record<string, unknown>, field = 'messages') {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '100200300', changes: [{ field, value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '233300000001', phone_number_id: phoneNumberId }, ...value } }] }],
  };
}

export function waText(from: string, id: string, text: string, name = 'Kofi Mensah', ts = Math.floor(Date.now() / 1000)) {
  return {
    contacts: [{ profile: { name }, wa_id: from }],
    messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }],
  };
}
