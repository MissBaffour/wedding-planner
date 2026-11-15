import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { WidgetApi, type WidgetConfig } from './api.ts';
import { lastServerId, mergeMessages, nextPollDelay, uuid, type ChatMessage, type PendingSend } from './store.ts';
import { css } from './styles.ts';

interface Props { api: WidgetApi; storageKey: string }

const load = <T,>(k: string, d: T): T => {
  try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : d; } catch { return d; }
};
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode / full */ } };

export function App({ api, storageKey }: Props) {
  const K = { token: `${storageKey}:token`, pending: `${storageKey}:pending`, seen: `${storageKey}:seen`, identified: `${storageKey}:identified` };
  const [cfg, setCfg] = useState<WidgetConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    load<PendingSend[]>(K.pending, []).map((p) => ({ clientId: p.clientId, from: 'visitor', text: p.text, createdAt: p.createdAt, pending: true })));
  const [draft, setDraft] = useState('');
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [identified, setIdentified] = useState(load(K.identified, false));
  const [showForm, setShowForm] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const errors = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastSeen = useRef<string | undefined>(load<string | undefined>(K.seen, undefined));

  // Session (re-uses the stored visitor token so returning visitors keep their history).
  const connect = useCallback(async () => {
    try {
      const s = await api.session(load<string | null>(K.token, null));
      save(K.token, s.visitorToken);
      setCfg(s.widget);
      if (s.identified) { setIdentified(true); save(K.identified, true); }
      return true;
    } catch (e) {
      if ((e as { status?: number }).status === 404 || (e as { status?: number }).status === 403) setUnavailable(true);
      return false;
    }
  }, [api]);

  // Flush messages typed while offline. Same clientId on every retry => never duplicated server-side.
  const flush = useCallback(async () => {
    const pending = load<PendingSend[]>(K.pending, []);
    for (const p of pending) {
      try {
        const r = await api.send(p.clientId, p.text);
        save(K.pending, load<PendingSend[]>(K.pending, []).filter((x) => x.clientId !== p.clientId));
        setMessages((m) => mergeMessages(m, [{ id: r.id, clientId: p.clientId, from: 'visitor', text: p.text, createdAt: r.createdAt }]));
      } catch (e) {
        if ((e as { status?: number }).status === 401) await connect();
        return; // keep order: stop at the first failure
      }
    }
  }, [api, connect]);

  const poll = useCallback(async () => {
    const fresh = await api.poll(lastServerId(messagesRef.current), open);
    if (fresh.length) setMessages((m) => mergeMessages(m, fresh));
  }, [api, open]);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => { void connect(); }, [connect]);

  // Poll loop with backoff; pauses while hidden.
  useEffect(() => {
    if (!cfg) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try { await flush(); await poll(); errors.current = 0; setOnline(true); }
      catch (e) {
        errors.current++;
        if ((e as { status?: number }).status === 401) await connect();
        else setOnline(false);
      }
      if (!stop) t = setTimeout(loop, nextPollDelay({ open, hidden: document.hidden, errors: errors.current }));
    };
    void loop();
    const wake = () => { clearTimeout(t); void loop(); };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { stop = true; clearTimeout(t); window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake); };
  }, [cfg, open, flush, poll, connect]);

  useEffect(() => {
    if (open) {
      lastSeen.current = lastServerId(messages);
      save(K.seen, lastSeen.current);
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [open, messages.length]);

  const unread = open ? 0 : messages.filter((m) => m.from === 'business' && m.id && (!lastSeen.current || m.id > lastSeen.current)).length;

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    const p: PendingSend = { clientId: uuid(), text, createdAt: new Date().toISOString() };
    save(K.pending, [...load<PendingSend[]>(K.pending, []), p]);
    setMessages((m) => [...m, { clientId: p.clientId, from: 'visitor', text, createdAt: p.createdAt, pending: true }]);
    setDraft('');
    if (cfg?.askForContact && !identified) setShowForm(true);
    try { await flush(); } catch { /* retried by the poll loop */ }
  };

  if (unavailable || !cfg) return null;

  return (
    <>
      <style>{css(cfg.color)}</style>
      {open && (
        <div class="panel" role="dialog" aria-label={cfg.title} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <div class="head">
            <div><h2>{cfg.title}</h2><p>{cfg.businessName}</p></div>
            <button class="x" aria-label="Close chat" onClick={() => setOpen(false)}>×</button>
          </div>
          {!online && <div class="offline">You're offline. Messages will send when you're back online.</div>}
          <div class="list" ref={listRef} aria-live="polite">
            {cfg.greeting && <div class="msg business">{cfg.greeting}</div>}
            {messages.map((m) => (
              <div key={m.id ?? m.clientId} class={`msg ${m.from}${m.pending ? ' pending' : ''}`}>
                {m.text}
                <div class="meta">{m.pending ? 'Sending…' : m.from === 'business' && m.agentName ? m.agentName : ''}</div>
              </div>
            ))}
          </div>
          {showForm && !identified && (
            <ContactForm api={api} cfg={cfg} onDone={(ok) => { setShowForm(false); if (ok) { setIdentified(true); save(K.identified, true); } }} />
          )}
          <div class="compose">
            <textarea rows={1} value={draft} aria-label="Type your message" placeholder="Type a message…" maxLength={2000}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            <button class="btn" onClick={() => void send()} aria-label="Send">Send</button>
          </div>
        </div>
      )}
      <button class="launcher" aria-label={open ? 'Close chat' : 'Open chat'} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2z" /></svg>
        {unread > 0 && <span class="badge">{unread}</span>}
      </button>
    </>
  );
}

function ContactForm({ api, cfg, onDone }: { api: WidgetApi; cfg: WidgetConfig; onDone: (ok: boolean) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!consent) return setErr('Please tick the box to continue.');
    try { await api.identify({ name: name || undefined, phone: phone || undefined, consent: true }); onDone(true); }
    catch { setErr('Check the phone number, e.g. 024 123 4567.'); }
  };
  return (
    <div class="form">
      <div>So we can reply even if you leave the page (optional):</div>
      <input type="text" placeholder="Your name" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} aria-label="Your name" />
      <input type="tel" placeholder="Phone, e.g. 024 123 4567" value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} aria-label="Phone number" />
      <label><input type="checkbox" checked={consent} onChange={(e) => setConsent((e.target as HTMLInputElement).checked)} />
        <span>I agree that {cfg.businessName} may use these details to reply to me.{cfg.privacyNoticeUrl && <> <a href={cfg.privacyNoticeUrl} target="_blank" rel="noopener">Privacy notice</a></>}</span>
      </label>
      {err && <div class="err">{err}</div>}
      <div class="row"><button class="btn" onClick={() => void submit()}>Save</button><button class="btn secondary" onClick={() => onDone(false)}>Skip</button></div>
    </div>
  );
}
