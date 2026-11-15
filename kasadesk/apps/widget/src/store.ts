/** Pure state helpers (unit-tested). */
export interface ChatMessage {
  id?: string;            // server id once stored
  clientId?: string;      // visitor messages: generated locally, reconciles optimistic copies
  from: 'visitor' | 'business';
  text: string;
  createdAt: string;
  pending?: boolean;      // not yet confirmed by the server
  agentName?: string | null;
}

export interface PendingSend { clientId: string; text: string; createdAt: string }

/** Merge server messages into the list: dedupe by id, replace optimistic copies by clientId, keep order. */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const out = [...current];
  for (const m of incoming) {
    const byId = m.id ? out.findIndex((x) => x.id === m.id) : -1;
    if (byId >= 0) { out[byId] = { ...out[byId], ...m, pending: false }; continue; }
    const byClient = m.clientId ? out.findIndex((x) => x.clientId === m.clientId) : -1;
    if (byClient >= 0) { out[byClient] = { ...m, pending: false }; continue; }
    out.push(m);
  }
  // Server-confirmed messages sort by id (time-ordered UUIDv7); pending ones stay at the end.
  const confirmed = out.filter((m) => m.id).sort((a, b) => (a.id! < b.id! ? -1 : 1));
  return [...confirmed, ...out.filter((m) => !m.id)];
}

export function lastServerId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.id) return messages[i]!.id;
  return undefined;
}

/** Poll faster while open; back off on errors and when the tab is hidden (saves data and battery). */
export function nextPollDelay(o: { open: boolean; hidden: boolean; errors: number }): number {
  if (o.errors > 0) return Math.min(60_000, 2_000 * 2 ** Math.min(o.errors, 5));
  if (o.hidden) return 60_000;
  return o.open ? 3_000 : 20_000;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
