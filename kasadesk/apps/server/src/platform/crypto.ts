import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

export interface Encrypted {
  /** iv (12) || auth tag (16) || ciphertext */
  data: Buffer;
  keyId: string;
}

/**
 * AES-256-GCM envelope for secrets at rest (channel tokens, merchant API keys).
 * `aad` binds a ciphertext to its row (e.g. `channel:<id>`) so it cannot be
 * copied onto another row and still decrypt.
 * Rotation: add a new key, make it active, re-encrypt rows lazily; keep old keys until no row uses them.
 */
export class Keyring {
  private readonly keys: Map<string, Buffer>;

  constructor(keys: Map<string, Buffer>, private readonly activeKeyId: string) {
    for (const [id, k] of keys) {
      if (k.length !== 32) throw new Error(`encryption key ${id} must be 32 bytes`);
    }
    if (!keys.has(activeKeyId)) throw new Error(`active encryption key ${activeKeyId} not in keyring`);
    this.keys = keys;
  }

  static parse(spec: string, activeKeyId: string): Keyring {
    const keys = new Map<string, Buffer>();
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(':');
      if (idx < 1) throw new Error('ENCRYPTION_KEYS entries must look like id:base64key');
      keys.set(part.slice(0, idx), Buffer.from(part.slice(idx + 1), 'base64'));
    }
    return new Keyring(keys, activeKeyId);
  }

  encrypt(plaintext: Buffer | string, aad?: string): Encrypted {
    const key = this.keys.get(this.activeKeyId)!;
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { data: Buffer.concat([iv, cipher.getAuthTag(), ct]), keyId: this.activeKeyId };
  }

  decrypt(enc: Encrypted, aad?: string): Buffer {
    const key = this.keys.get(enc.keyId);
    if (!key) throw new Error(`unknown encryption key id ${enc.keyId}`);
    const iv = enc.data.subarray(0, IV_LEN);
    const tag = enc.data.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = enc.data.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (aad) decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  encryptJson(value: unknown, aad?: string): Encrypted {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T>(enc: Encrypted, aad?: string): T {
    return JSON.parse(this.decrypt(enc, aad).toString('utf8')) as T;
  }

  needsRotation(keyId: string): boolean {
    return keyId !== this.activeKeyId;
  }
}

export const sha256 = (input: string | Buffer): Buffer => createHash('sha256').update(input).digest();

/** URL-safe random token; store only sha256(token). */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
