/**
 * WhatsApp customer service window: free-form messages are allowed only within
 * 24 hours of the customer's last message to this business number. Outside it,
 * only approved templates can be sent. (Meta policy: verify against current docs;
 * Meta also has longer "free entry point" windows for some ad-originated chats,
 * which this does not model.)
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isWithinServiceWindow(lastInboundAt: Date | null, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < SERVICE_WINDOW_MS;
}

export function windowClosesAt(lastInboundAt: Date | null): Date | null {
  return lastInboundAt ? new Date(lastInboundAt.getTime() + SERVICE_WINDOW_MS) : null;
}
