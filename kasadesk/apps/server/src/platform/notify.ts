import type { FastifyBaseLogger } from 'fastify';

export type NotificationTemplate =
  | 'invitation'
  | 'password_reset'
  | 'trial_ending'
  | 'subscription_status_changed';

export interface Notification {
  to: { email?: string | null; phone?: string | null };
  template: NotificationTemplate;
  data: Record<string, unknown>;
}

/** Delivery is implemented with real SMS/email providers in step 6. */
export interface Notifier {
  send(n: Notification): Promise<void>;
}

/** Development: write to the log. Never use in production (tokens appear in logs). */
export class LogNotifier implements Notifier {
  constructor(private readonly log: Pick<FastifyBaseLogger, 'info'>) {}
  async send(n: Notification): Promise<void> {
    this.log.info({ notification: n }, `notification: ${n.template}`);
  }
}

/** Tests: keep everything in memory. */
export class MemoryNotifier implements Notifier {
  readonly sent: Notification[] = [];
  async send(n: Notification): Promise<void> {
    this.sent.push(n);
  }
  last(template: NotificationTemplate): Notification | undefined {
    return [...this.sent].reverse().find((n) => n.template === template);
  }
}
