/**
 * Minimal WhatsApp Cloud API (Graph API) client.
 * Only endpoints from Meta's public Cloud API reference are used:
 *   POST /{phone-number-id}/messages      send message / mark as read
 *   POST /{phone-number-id}/media         upload media
 *   GET  /{media-id}                      media metadata incl. short-lived download URL
 *   GET  /{phone-number-id}               number details (connection check)
 *   GET  /{waba-id}/message_templates     list templates (paginated)
 *   POST /{waba-id}/subscribed_apps       subscribe the app to the WABA's webhooks
 */
import { ChannelError } from '../core/types.ts';

export interface GraphConfig {
  baseUrl: string;   // https://graph.facebook.com
  version: string;   // v23.0
  timeoutMs?: number;
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; error_data?: { details?: string }; fbtrace_id?: string };
}

/**
 * Meta error codes that are worth retrying with backoff (throughput / temporary).
 * Check against Meta's current "Cloud API error codes" page; unknown codes fail permanently
 * (and agents see the error) unless the HTTP status is 5xx/429.
 */
const RETRYABLE_CODES = new Set([1, 2, 4, 17, 80007, 130429, 131000, 131016, 131056, 133004]);

export class WhatsAppClient {
  constructor(private readonly cfg: GraphConfig, private readonly accessToken: string) {}

  private url(path: string) {
    return `${this.cfg.baseUrl.replace(/\/$/, '')}/${this.cfg.version}/${path.replace(/^\//, '')}`;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown | FormData): Promise<T> {
    let res: Response;
    try {
      res = await fetch(path.startsWith('http') ? path : this.url(path), {
        method,
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(body && !(body instanceof FormData) ? { 'content-type': 'application/json' } : {}),
        },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new ChannelError(`network error calling WhatsApp: ${(err as Error).message}`, 'network', true);
    }
    const text = await res.text();
    const json = text ? (safeJson(text) as T & GraphErrorBody) : ({} as T & GraphErrorBody);
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      const code = e.code ?? res.status;
      const retryable = res.status >= 500 || res.status === 429 || RETRYABLE_CODES.has(Number(code));
      throw new ChannelError(e.message ?? `WhatsApp API HTTP ${res.status}`, String(code), retryable, {
        status: res.status, subcode: e.error_subcode, details: e.error_data?.details, fbtrace_id: e.fbtrace_id,
      });
    }
    return json;
  }

  sendMessage(phoneNumberId: string, message: Record<string, unknown>) {
    return this.request<{ messages?: { id: string }[]; contacts?: { wa_id: string }[] }>('POST', `${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...message,
    });
  }

  markRead(phoneNumberId: string, providerMessageId: string) {
    return this.request('POST', `${phoneNumberId}/messages`, {
      messaging_product: 'whatsapp', status: 'read', message_id: providerMessageId,
    });
  }

  async uploadMedia(phoneNumberId: string, data: Buffer, mimeType: string, filename = 'file') {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    return this.request<{ id: string }>('POST', `${phoneNumberId}/media`, form);
  }

  getMedia(mediaId: string) {
    return this.request<{ url: string; mime_type: string; sha256?: string; file_size?: number; id: string }>('GET', mediaId);
  }

  /** The URL from getMedia() is short-lived and also needs the bearer token. */
  async downloadMedia(url: string, maxBytes: number): Promise<Buffer> {
    let res: Response;
    try {
      res = await fetch(url, { headers: { authorization: `Bearer ${this.accessToken}` }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new ChannelError(`media download failed: ${(err as Error).message}`, 'network', true);
    }
    if (!res.ok) throw new ChannelError(`media download HTTP ${res.status}`, String(res.status), res.status >= 500 || res.status === 429);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new ChannelError(`media too large (${len} bytes)`, 'media_too_large', false);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ChannelError(`media too large (${buf.length} bytes)`, 'media_too_large', false);
    return buf;
  }

  getPhoneNumber(phoneNumberId: string) {
    return this.request<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>(
      'GET', `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
    );
  }

  subscribeApp(wabaId: string) {
    return this.request<{ success?: boolean }>('POST', `${wabaId}/subscribed_apps`);
  }

  async listTemplates(wabaId: string, maxPages = 20) {
    type Page = { data?: Record<string, any>[]; paging?: { next?: string } };
    const all: Record<string, any>[] = [];
    let next: string | undefined = `${wabaId}/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100`;
    for (let i = 0; next && i < maxPages; i++) {
      const page: Page = await this.request<Page>('GET', next);
      all.push(...(page.data ?? []));
      next = page.paging?.next;
    }
    return all;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 200) } };
  }
}
