import type { Keyring } from '../../../platform/crypto.ts';
import type { Tx } from '../../../platform/db/index.ts';
import { Errors } from '../../../platform/errors.ts';

export const channelAad = (channelId: string) => `channel:${channelId}`;

export function encryptCredentials(keyring: Keyring, channelId: string, creds: Record<string, string>) {
  const enc = keyring.encryptJson(creds, channelAad(channelId));
  return { credentials_enc: enc.data, credentials_key_id: enc.keyId };
}

export function decryptCredentials(
  keyring: Keyring,
  row: { id: string; credentials_enc: Buffer | null; credentials_key_id: string | null },
): Record<string, string> {
  if (!row.credentials_enc || !row.credentials_key_id) return {};
  return keyring.decryptJson({ data: row.credentials_enc, keyId: row.credentials_key_id }, channelAad(row.id));
}

/** Loads a channel (tenant-scoped) with decrypted credentials. */
export async function loadChannel(tx: Tx, keyring: Keyring, channelId: string) {
  const row = await tx.selectFrom('channels').selectAll().where('id', '=', channelId).executeTakeFirst();
  if (!row) throw Errors.notFound('channel_not_found');
  return { ...row, credentials: decryptCredentials(keyring, row) };
}
