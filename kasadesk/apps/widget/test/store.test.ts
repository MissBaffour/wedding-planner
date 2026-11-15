import { describe, expect, it } from 'vitest';
import { lastServerId, mergeMessages, nextPollDelay, uuid, type ChatMessage } from '../src/store.ts';

const t = '2026-01-01T00:00:00Z';
describe('mergeMessages', () => {
  it('replaces the optimistic copy when the server confirms it (by clientId)', () => {
    const local: ChatMessage[] = [{ clientId: 'c1', from: 'visitor', text: 'hi', createdAt: t, pending: true }];
    const merged = mergeMessages(local, [{ id: '01a', clientId: 'c1', from: 'visitor', text: 'hi', createdAt: t }]);
    expect(merged).toEqual([{ id: '01a', clientId: 'c1', from: 'visitor', text: 'hi', createdAt: t, pending: false }]);
  });
  it('dedupes by id, keeps server order, leaves unconfirmed at the end', () => {
    const local: ChatMessage[] = [
      { id: '01b', from: 'business', text: 'b', createdAt: t },
      { clientId: 'c9', from: 'visitor', text: 'offline', createdAt: t, pending: true },
    ];
    const merged = mergeMessages(local, [{ id: '01a', from: 'visitor', text: 'a', createdAt: t }, { id: '01b', from: 'business', text: 'b', createdAt: t }]);
    expect(merged.map((m) => m.id ?? m.clientId)).toEqual(['01a', '01b', 'c9']);
    expect(lastServerId(merged)).toBe('01b');
  });
});

describe('nextPollDelay', () => {
  it('polls fast when open, slow when closed or hidden, backs off on errors', () => {
    expect(nextPollDelay({ open: true, hidden: false, errors: 0 })).toBe(3000);
    expect(nextPollDelay({ open: false, hidden: false, errors: 0 })).toBe(20000);
    expect(nextPollDelay({ open: true, hidden: true, errors: 0 })).toBe(60000);
    expect(nextPollDelay({ open: true, hidden: false, errors: 1 })).toBe(4000);
    expect(nextPollDelay({ open: true, hidden: false, errors: 10 })).toBe(60000);
  });
});

it('uuid looks like a v4 uuid', () => {
  expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
