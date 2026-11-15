import type { ChatMessage } from './store.ts';

export interface WidgetConfig {
  businessName: string;
  title: string;
  greeting: string;
  color: string;
  askForContact: boolean;
  privacyNoticeUrl: string | null;
}

export class WidgetApi {
  token: string | null = null;
  constructor(private readonly base: string, private readonly key: string) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}/widget/v1/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token && { authorization: `Bearer ${this.token}` }) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res.json() as Promise<T>;
  }

  async session(previous: string | null) {
    const r = await this.call<{ visitorToken: string; widget: WidgetConfig; identified: boolean }>('POST', 'session', {
      widgetKey: this.key, ...(previous && { visitorToken: previous }),
    });
    this.token = r.visitorToken;
    return r;
  }

  send(clientId: string, text: string) {
    return this.call<{ id: string; clientId: string; createdAt: string }>('POST', 'messages', { clientId, text });
  }

  async poll(after: string | undefined, seen: boolean): Promise<ChatMessage[]> {
    const q = new URLSearchParams();
    if (after) q.set('after', after);
    if (seen) q.set('seen', '1');
    const r = await this.call<{ messages: { id: string; from: 'visitor' | 'business'; text: string | null; createdAt: string; clientId?: string; agentName?: string | null }[] }>('GET', `messages?${q}`);
    return r.messages.map((m) => ({ id: m.id, from: m.from, text: m.text ?? '', createdAt: m.createdAt, clientId: m.clientId, agentName: m.agentName }));
  }

  identify(body: { name?: string; phone?: string; email?: string; consent: true }) {
    return this.call<{ ok: boolean }>('POST', 'identify', body);
  }
}
