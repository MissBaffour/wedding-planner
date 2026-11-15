import { hash, verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';

// Argon2id with OWASP's recommended minimum (19 MiB, t=2, p=1): safe and cheap
// enough for small cloud instances.
const OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;
/** Burn the same time as a real check when the email does not exist (no user enumeration by timing). */
export async function dummyVerify(password: string): Promise<false> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
  return false;
}
