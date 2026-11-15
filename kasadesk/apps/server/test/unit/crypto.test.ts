import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring } from '../../src/platform/crypto.ts';

const k = () => randomBytes(32).toString('base64');

describe('Keyring (AES-256-GCM)', () => {
  const k1 = k();
  const k2 = k();
  const ring = Keyring.parse(`k1:${k1}`, 'k1');

  it('round-trips JSON with AAD', () => {
    const enc = ring.encryptJson({ accessToken: 'EAAG...' }, 'channel:123');
    expect(enc.keyId).toBe('k1');
    expect(enc.data.toString('utf8')).not.toContain('EAAG');
    expect(ring.decryptJson(enc, 'channel:123')).toEqual({ accessToken: 'EAAG...' });
  });

  it('fails with the wrong AAD (ciphertext moved to another row)', () => {
    const enc = ring.encryptJson({ a: 1 }, 'channel:123');
    expect(() => ring.decrypt(enc, 'channel:999')).toThrow();
  });

  it('detects tampering', () => {
    const enc = ring.encrypt('secret');
    enc.data[enc.data.length - 1]! ^= 0xff;
    expect(() => ring.decrypt(enc)).toThrow();
  });

  it('supports rotation: new key encrypts, old key still decrypts', () => {
    const old = ring.encrypt('legacy');
    const rotated = Keyring.parse(`k1:${k1},k2:${k2}`, 'k2');
    expect(rotated.decrypt(old).toString()).toBe('legacy');
    expect(rotated.encrypt('new').keyId).toBe('k2');
    expect(rotated.needsRotation(old.keyId)).toBe(true);
  });

  it('rejects bad keys', () => {
    expect(() => Keyring.parse('k1:dG9vc2hvcnQ=', 'k1')).toThrow(/32 bytes/);
    expect(() => Keyring.parse(`k1:${k1}`, 'k9')).toThrow(/not in keyring/);
  });
});
