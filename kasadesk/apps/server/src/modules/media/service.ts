import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../platform/config.ts';
import { sha256, type Keyring } from '../../platform/crypto.ts';
import { withTenant, type DB } from '../../platform/db/index.ts';
import { Errors } from '../../platform/errors.ts';
import { tenantOf } from '../../platform/http/guard.ts';
import { parse } from '../../platform/http/validate.ts';
import type { MediaJob } from '../../platform/queues.ts';
import type { ObjectStorage } from '../../platform/storage.ts';
import { decryptCredentials } from '../channels/core/repo.ts';
import { ChannelError } from '../channels/core/types.ts';
import { WhatsAppClient, type GraphConfig } from '../channels/whatsapp/client.ts';

export interface MediaDeps {
  db: DB;
  keyring: Keyring;
  storage: ObjectStorage;
  graph: GraphConfig;
  config: Config;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'video/mp4': 'mp4', 'application/pdf': 'pdf',
};

/**
 * Worker: copy inbound media into our storage. Provider URLs expire (WhatsApp media
 * links are short-lived), and voice notes are needed later for transcription.
 */
export async function downloadAttachment(deps: MediaDeps, job: MediaJob): Promise<'stored' | 'skipped' | 'failed'> {
  const ctx = { businessId: job.businessId, userId: null };
  const row = await withTenant(deps.db, ctx, (tx) =>
    tx.selectFrom('message_attachments')
      .innerJoin('messages', 'messages.id', 'message_attachments.message_id')
      .innerJoin('channels', 'channels.id', 'messages.channel_id')
      .select([
        'message_attachments.id', 'message_attachments.storage_key', 'message_attachments.provider_media_id',
        'message_attachments.mime_type', 'channels.id as channel_id', 'channels.type as channel_type',
        'channels.credentials_enc', 'channels.credentials_key_id', 'message_attachments.created_at',
      ])
      .where('message_attachments.id', '=', job.attachmentId)
      .executeTakeFirst());
  if (!row || row.storage_key || !row.provider_media_id) return 'skipped';
  if (row.channel_type !== 'whatsapp') return 'skipped';

  try {
    const creds = decryptCredentials(deps.keyring, { id: row.channel_id, credentials_enc: row.credentials_enc, credentials_key_id: row.credentials_key_id });
    const client = new WhatsAppClient(deps.graph, creds.accessToken ?? '');
    const meta = await client.getMedia(row.provider_media_id);
    const data = await client.downloadMedia(meta.url, deps.config.MEDIA_MAX_BYTES);
    const mime = meta.mime_type || row.mime_type;
    const d = row.created_at;
    const key = `${job.businessId}/media/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${row.id}.${EXT[mime.split(';')[0]!.trim()] ?? 'bin'}`;
    await deps.storage.put(key, data, mime);
    await withTenant(deps.db, ctx, (tx) =>
      tx.updateTable('message_attachments')
        .set({ storage_key: key, size_bytes: data.length, sha256: sha256(data), mime_type: mime })
        .where('id', '=', row.id).execute());
    return 'stored';
  } catch (err) {
    if (err instanceof ChannelError && !err.retryable) return 'failed'; // e.g. too large or expired: keep the row, no file
    throw err;
  }
}

/** Agents fetch media through the API (tenant-checked), never directly from storage. */
export function mediaRoutes(app: FastifyInstance, deps: { db: DB; storage: ObjectStorage }) {
  app.get('/v1/attachments/:id/content', async (req, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const t = tenantOf(req);
    const a = await withTenant(deps.db, t, (tx) =>
      tx.selectFrom('message_attachments').select(['storage_key', 'mime_type', 'filename']).where('id', '=', id).executeTakeFirst());
    if (!a) throw Errors.notFound();
    if (!a.storage_key) throw Errors.notFound('media_not_ready', 'The file is still downloading or could not be fetched.');
    const data = await deps.storage.get(a.storage_key);
    return reply
      .header('content-type', a.mime_type)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${a.mime_type.startsWith('image/') || a.mime_type.startsWith('audio/') ? 'inline' : 'attachment'}; filename="${(a.filename ?? id).replace(/"/g, '')}"`)
      .send(data);
  });
}
