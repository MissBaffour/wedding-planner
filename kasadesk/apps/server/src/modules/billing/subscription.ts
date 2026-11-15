/**
 * Subscription state machine — pure functions, no I/O.
 *
 * The effective status is DERIVED from timestamps on every request, so
 * enforcement is correct even if the background sweep is late. The stored
 * `subscription_status` is a cache the sweep keeps up to date (and uses to
 * send notifications on transitions).
 *
 *   never paid:  trialing ──trial_ends_at──► read_only ──+7d──► paused
 *   paid:        active ──period_end──► past_due ──+3d──► read_only ──+7d──► paused
 */
import type { SubscriptionStatus } from '../../platform/db/schema.ts';

export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 3;
export const READ_ONLY_DAYS = 7;

const DAY = 86_400_000;

export interface SubscriptionFields {
  subscription_status: SubscriptionStatus;
  trial_ends_at: Date;
  current_period_end: Date | null;
}

export interface Timeline {
  status: SubscriptionStatus;
  /** When full access ends (trial end, or period end + grace). */
  fullAccessEndsAt: Date;
  readOnlyEndsAt: Date;
  graceEndsAt: Date | null;
}

export function timeline(b: SubscriptionFields, now: Date = new Date()): Timeline {
  const paid = b.current_period_end !== null;
  const base = paid ? b.current_period_end! : b.trial_ends_at;
  const graceEndsAt = paid ? new Date(base.getTime() + GRACE_DAYS * DAY) : null;
  const fullAccessEndsAt = graceEndsAt ?? base;
  const readOnlyEndsAt = new Date(fullAccessEndsAt.getTime() + READ_ONLY_DAYS * DAY);
  return { status: deriveStatus(b, now), fullAccessEndsAt, readOnlyEndsAt, graceEndsAt };
}

export function deriveStatus(b: SubscriptionFields, now: Date = new Date()): SubscriptionStatus {
  if (b.subscription_status === 'cancelled') return 'cancelled';
  const t = now.getTime();
  if (b.current_period_end === null) {
    const end = b.trial_ends_at.getTime();
    if (t < end) return 'trialing';
    if (t < end + READ_ONLY_DAYS * DAY) return 'read_only';
    return 'paused';
  }
  const end = b.current_period_end.getTime();
  if (t < end) return 'active';
  if (t < end + GRACE_DAYS * DAY) return 'past_due';
  if (t < end + (GRACE_DAYS + READ_ONLY_DAYS) * DAY) return 'read_only';
  return 'paused';
}

export type AccessLevel = 'full' | 'read_only' | 'locked';

export function accessLevel(status: SubscriptionStatus): AccessLevel {
  switch (status) {
    case 'trialing':
    case 'active':
    case 'past_due':
      return 'full';
    case 'read_only':
      return 'read_only';
    default:
      return 'locked';
  }
}

/**
 * What a route needs:
 *  - 'write'  : changes data or sends messages (blocked in read_only and locked)
 *  - 'read'   : views data (blocked when locked)
 *  - 'always' : billing, data export, account/session (never blocked, so customers can pay or leave)
 */
export type RouteAccess = 'write' | 'read' | 'always';

export function isAllowed(level: AccessLevel, need: RouteAccess): boolean {
  if (need === 'always') return true;
  if (level === 'full') return true;
  if (level === 'read_only') return need === 'read';
  return false;
}

export function daysLeft(until: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / DAY));
}
