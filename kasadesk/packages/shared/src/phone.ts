/**
 * Phone helpers. KasaDesk stores phones as E.164 (+233XXXXXXXXX).
 * Ghanaians commonly write numbers as 024 123 4567, 0241234567, 233241234567,
 * +233 24 123 4567 or 00233241234567; all normalize to +233241234567.
 */
const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: string, defaultCountry: 'GH' = 'GH'): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (s.startsWith('+')) return E164.test(s) ? s : null;
  if (!/^\d+$/.test(s)) return null;
  if (defaultCountry === 'GH') {
    if (s.length === 12 && s.startsWith('233')) return '+' + s;
    if (s.length === 10 && s.startsWith('0')) return '+233' + s.slice(1);
    if (s.length === 9 && !s.startsWith('0')) return '+233' + s;
  }
  return null;
}

export function isE164(s: string): boolean {
  return E164.test(s);
}

export type GhanaNetwork = 'mtn' | 'telecel' | 'airteltigo';

/**
 * Network guessed from the number prefix. ONLY a hint: Ghana has mobile number
 * portability, so a ported number keeps its old prefix. Always let the payer
 * confirm the network before a MoMo charge.
 */
const PREFIXES: Record<string, GhanaNetwork> = {
  '24': 'mtn', '25': 'mtn', '53': 'mtn', '54': 'mtn', '55': 'mtn', '59': 'mtn',
  '20': 'telecel', '50': 'telecel',
  '26': 'airteltigo', '27': 'airteltigo', '56': 'airteltigo', '57': 'airteltigo',
};

export function ghanaNetworkHint(e164: string): GhanaNetwork | null {
  if (!/^\+233\d{9}$/.test(e164)) return null;
  return PREFIXES[e164.slice(4, 6)] ?? null;
}
