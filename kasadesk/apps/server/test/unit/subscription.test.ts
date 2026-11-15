import { describe, expect, it } from 'vitest';
import { accessLevel, deriveStatus, isAllowed, timeline, type SubscriptionFields } from '../../src/modules/billing/subscription.ts';

const DAY = 86_400_000;
const t0 = new Date('2026-12-01T00:00:00Z');
const at = (days: number) => new Date(t0.getTime() + days * DAY);
const trial = (endsInDays: number): SubscriptionFields => ({ subscription_status: 'trialing', trial_ends_at: at(endsInDays), current_period_end: null });
const paid = (periodEndDays: number): SubscriptionFields => ({ subscription_status: 'active', trial_ends_at: at(-30), current_period_end: at(periodEndDays) });

describe('deriveStatus — trial', () => {
  it.each([
    [0, 'trialing'], [13.99, 'trialing'], [14, 'read_only'], [20.99, 'read_only'], [21, 'paused'], [400, 'paused'],
  ])('day %s of a 14-day trial -> %s', (day, expected) => {
    expect(deriveStatus(trial(14), at(day as number))).toBe(expected);
  });
});

describe('deriveStatus — paid', () => {
  it.each([
    [-1, 'active'], [0, 'past_due'], [2.99, 'past_due'], [3, 'read_only'], [9.99, 'read_only'], [10, 'paused'],
  ])('%s days after period end -> %s', (day, expected) => {
    expect(deriveStatus(paid(0), at(day as number))).toBe(expected);
  });

  it('cancelled stays cancelled', () => {
    expect(deriveStatus({ ...paid(30), subscription_status: 'cancelled' }, t0)).toBe('cancelled');
  });

  it('stored status is ignored in favour of timestamps (late sweep cannot extend access)', () => {
    expect(deriveStatus({ ...trial(-30), subscription_status: 'trialing' }, t0)).toBe('paused');
  });
});

describe('timeline', () => {
  it('trial: read-only ends 7 days after the trial', () => {
    const tl = timeline(trial(14), t0);
    expect(tl.fullAccessEndsAt).toEqual(at(14));
    expect(tl.readOnlyEndsAt).toEqual(at(21));
    expect(tl.graceEndsAt).toBeNull();
  });
  it('paid: 3-day grace then 7 days read-only', () => {
    const tl = timeline(paid(0), t0);
    expect(tl.graceEndsAt).toEqual(at(3));
    expect(tl.readOnlyEndsAt).toEqual(at(10));
  });
});

describe('access rules', () => {
  it('maps statuses to access levels', () => {
    expect(accessLevel('trialing')).toBe('full');
    expect(accessLevel('past_due')).toBe('full');
    expect(accessLevel('read_only')).toBe('read_only');
    expect(accessLevel('paused')).toBe('locked');
    expect(accessLevel('cancelled')).toBe('locked');
  });
  it('enforces route needs', () => {
    expect(isAllowed('read_only', 'read')).toBe(true);
    expect(isAllowed('read_only', 'write')).toBe(false);
    expect(isAllowed('locked', 'read')).toBe(false);
    expect(isAllowed('locked', 'always')).toBe(true);
  });
});
