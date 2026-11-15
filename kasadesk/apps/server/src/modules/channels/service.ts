import { uuidv7 } from '@kasadesk/shared';
import { z } from 'zod';
import { audit } from '../../platform/audit.ts';
import type { Config } from '../../platform/config.ts';
import { randomToken, type Keyring } from '../../platform/crypto.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import { Errors, mapDbError } from '../../platform/errors.ts';
import type { TenantState } from '../../platform/http/types.ts';
import { emit } from '../../platform/outbox.ts';
import type { SessionMeta } from '../auth/sessions.ts';
import { encryptCredentials } from './core/repo.ts';
import { ChannelError } from './core/types.ts';
import { WhatsAppClient, type GraphConfig } from './whatsapp/client.ts';

export const ConnectWhatsAppBody = z.object({
  name: z.string().trim().min(1).max(80),
  phoneNumberId: z.string().regex(/^\d{5,30}$/, 'Phone number ID from WhatsApp Manager (digits)'),
  wabaId: z.string().regex(/^\d{5,30}$/, 'WhatsApp Business Account ID (digits)'),
  accessToken: z.string().min(20).max(1000),
  /** platform = your KasaDesk Meta app receives webhooks; byo = the business's own Meta app. */
  mode: z.enum(['platform', 'byo']).default('platform'),
  appSecret: z.string().min(16).max(200).optional(),
}).refine((b) => b.mode !== 'byo' || b.appSecret, { message: 'appSecret is required for your own Meta app', path: ['appSecret'] });

const origin = z.string().url().transform((u) => new URL(u).origin);
export const WebchatBody = z.object({
  name: z.string().trim().min(1).max(80),
  /** Sites allowed to embed the widget. Empty = any site (not recommended in production). */
  allowedOrigins: z.array(origin).max(20).default([]),
  title: z.string().trim().min(1).max(60).default('Chat with us'),
  greeting: z.string().trim().max(300).default('Hi! How can we help you today?'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),
  askForContact: z.boolean().default(true),
  privacyNoticeUrl: z.string().url().optional(),
});
export const UpdateWebchatBody = WebchatBody.partial().omit({ name: true }).extend({ name: z.string().trim().min(1).max(80).optional() }).strict();

const PUBLIC_FIELDS = ['id', 'type', 'name', 'external_id', 'status', 'config', 'last_error', 'connected_at', 'created_at', 'webhook_key'] as const;

export class ChannelService {
  constructor(private readonly d: { db: DB; config: Config; keyring: Keyring; graph: GraphConfig }) {}

  private view(c: { id: string; type: string; webhook_key: string | null; external_id: string; config: unknown } & Record<string, unknown>) {
    const { webhook_key, ...rest } = c;
    return {
      ...rest,
      ...(c.type === 'whatsapp' && webhook_key && { webhookUrl: `${this.d.config.PUBLIC_API_URL}/webhooks/whatsapp/${webhook_key}` }),
      ...(c.type === 'webchat' && { embedSnippet: this.snippet(c.external_id) }),
    };
  }

  snippet(widgetKey: string) {
    return `<script src="${this.d.config.WIDGET_SCRIPT_URL}" data-kasadesk-key="${widgetKey}" data-kasadesk-api="${this.d.config.PUBLIC_API_URL}" async></script>`;
  }

  async list(t: TenantState) {
    const rows = await withTenant(this.d.db, t, (tx) => tx.selectFrom('channels').select([...PUBLIC_FIELDS]).orderBy('created_at').execute());
    return rows.map((r) => this.view(r));
  }

  async connectWhatsApp(t: TenantState, input: z.infer<typeof ConnectWhatsAppBody>, meta: SessionMeta) {
    if (input.mode === 'platform' && !this.d.config.META_APP_SECRET) {
      throw Errors.badRequest('platform_app_not_configured', 'This KasaDesk server has no Meta app configured. Use mode "byo".');
    }
    let info: { display_phone_number?: string; verified_name?: string; quality_rating?: string } = {};
    if (!this.d.config.META_SKIP_CONNECT_CHECK) {
      const client = new WhatsAppClient(this.d.graph, input.accessToken);
      try {
        info = await client.getPhoneNumber(input.phoneNumberId);
        if (input.mode === 'platform') await client.subscribeApp(input.wabaId);
      } catch (err) {
        if (err instanceof ChannelError) {
          throw Errors.badRequest('whatsapp_check_failed', `WhatsApp rejected these details: ${err.message}`, { code: err.code });
        }
        throw err;
      }
    }

    const id = uuidv7();
    const webhookKey = input.mode === 'byo' ? `wa_${randomToken(24)}` : null;
    const verifyToken = input.mode === 'byo' ? randomToken(18) : undefined;
    const creds: Record<string, string> = { accessToken: input.accessToken };
    if (input.appSecret) creds.appSecret = input.appSecret;
    if (verifyToken) creds.verifyToken = verifyToken;

    const row = await withTenant(this.d.db, t, async (tx) => {
      try {
        const r = await tx.insertInto('channels').values({
          id, business_id: t.businessId, type: 'whatsapp', name: input.name, external_id: input.phoneNumberId,
          external_parent_id: input.wabaId, ...encryptCredentials(this.d.keyring, id, creds),
          config: JSON.stringify({ mode: input.mode, displayPhoneNumber: info.display_phone_number ?? null, verifiedName: info.verified_name ?? null, qualityRating: info.quality_rating ?? null }),
          status: 'active', webhook_key: webhookKey, connected_at: new Date(),
        }).returning([...PUBLIC_FIELDS]).executeTakeFirstOrThrow();
        await emit(tx, t.businessId, 'templates.sync', { channelId: id });
        await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'channel.connected', entityType: 'channel', entityId: id, changes: { type: 'whatsapp', mode: input.mode, phoneNumberId: input.phoneNumberId }, ...meta });
        return r;
      } catch (err) {
        if (mapDbError(err)?.status === 409) throw Errors.conflict('already_connected', 'This WhatsApp number is already connected to a KasaDesk account.');
        throw err;
      }
    });
    // The verify token is shown once (needed to register the webhook in the business's Meta app).
    return { ...this.view(row), ...(verifyToken && { verifyToken }) };
  }

  async connectWebchat(t: TenantState, input: z.infer<typeof WebchatBody>, meta: SessionMeta) {
    const id = uuidv7();
    const key = `wc_${randomToken(18)}`;
    const { name, ...config } = input;
    const row = await withTenant(this.d.db, t, async (tx) => {
      const r = await tx.insertInto('channels').values({
        id, business_id: t.businessId, type: 'webchat', name, external_id: key, external_parent_id: null,
        credentials_enc: null, credentials_key_id: null, config: JSON.stringify(config), status: 'active', connected_at: new Date(),
      }).returning([...PUBLIC_FIELDS]).executeTakeFirstOrThrow();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'channel.connected', entityType: 'channel', entityId: id, changes: { type: 'webchat' }, ...meta });
      return r;
    });
    return this.view(row);
  }

  async updateWebchat(t: TenantState, id: string, input: z.infer<typeof UpdateWebchatBody>, meta: SessionMeta) {
    return withTenant(this.d.db, t, async (tx) => {
      const c = await tx.selectFrom('channels').select(['type', 'config']).where('id', '=', id).executeTakeFirst();
      if (!c || c.type !== 'webchat') throw Errors.notFound();
      const { name, ...rest } = input;
      const config = { ...(c.config as Record<string, unknown>), ...rest };
      const r = await tx.updateTable('channels').set({ config: JSON.stringify(config), ...(name && { name }) })
        .where('id', '=', id).returning([...PUBLIC_FIELDS]).executeTakeFirstOrThrow();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'channel.updated', entityType: 'channel', entityId: id, changes: { fields: Object.keys(input) }, ...meta });
      return this.view(r);
    });
  }

  async disconnect(t: TenantState, id: string, meta: SessionMeta) {
    await withTenant(this.d.db, t, async (tx) => {
      // Wipe secrets; keep the row so conversation history stays intact.
      const r = await tx.updateTable('channels')
        .set({ status: 'disconnected', credentials_enc: null, credentials_key_id: null, webhook_key: null })
        .where('id', '=', id).executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw Errors.notFound();
      await audit(tx, { businessId: t.businessId, actorUserId: t.userId, action: 'channel.disconnected', entityType: 'channel', entityId: id, ...meta });
    });
  }

  listTemplates(t: TenantState, channelId: string) {
    return withTenant(this.d.db, t, (tx) =>
      tx.selectFrom('whatsapp_templates').select(['id', 'name', 'language', 'category', 'status', 'components', 'rejected_reason', 'synced_at'])
        .where('channel_id', '=', channelId).orderBy('name').orderBy('language').execute());
  }

  async requestTemplateSync(t: TenantState, channelId: string) {
    await withTenant(this.d.db, t, async (tx) => {
      const c = await tx.selectFrom('channels').select(['type', 'status']).where('id', '=', channelId).executeTakeFirst();
      if (!c || c.type !== 'whatsapp') throw Errors.notFound();
      if (c.status !== 'active') throw Errors.conflict('channel_inactive');
      await emit(tx, t.businessId, 'templates.sync', { channelId });
    });
  }
}
