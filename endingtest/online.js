import { cleanName } from './story.js?v=16';

const STORE = 'untorra-ending-outbox-v1';

export function readCast(data) {
  if (data?.version !== 1) throw new Error('Unsupported ending records');
  const profile = (value, kind) => {
    if (!value || typeof value.id !== 'string' || value.id.length > 100 || typeof value.name !== 'string') return null;
    const name = cleanName(value.name);
    const choices = kind === 'god' ? ['release', 'kill'] : ['take', 'decline'];
    const field = kind === 'god' ? 'response' : 'decision';
    if (!name || !choices.includes(value[field])) return null;
    return { id: value.id, name, [field]: value[field], role: kind, source: 'server-record' };
  };
  const god = profile(data.god, 'god');
  const visitors = Array.isArray(data.visitors) ? data.visitors.slice(0, 8).map(value => profile(value, 'visitor')).filter(Boolean) : [];
  return god || visitors.length ? { god, visitors } : null;
}

export class EndingRepository {
  constructor({ baseUrl = '', fetcher = globalThis.fetch?.bind(globalThis), storage, timeout = 1500 } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/?$/, '/') : '';
    this.fetcher = fetcher;
    try { this.storage = storage ?? globalThis.localStorage; } catch {}
    this.timeout = timeout;
    this.tokens = new Map();
    this.captured = new Map();
    this.queue = [];
    if (baseUrl) {
      try {
        const saved = JSON.parse(this.storage?.getItem(STORE) || '[]');
        if (Array.isArray(saved)) this.queue = saved.filter(item => item?.snapshot?.version === 1 && typeof item.submissionKey === 'string').slice(-20);
      } catch {}
      for (const item of this.queue) this.tokens.set(item.snapshot.runId, item.submissionKey);
      globalThis.addEventListener?.('online', () => this.flush());
      globalThis.addEventListener?.('pagehide', () => this.flush());
      this.flush();
    }
  }

  async request(route, options = {}) {
    const url = new URL(route, new URL(this.baseUrl, globalThis.location?.href));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetcher(url, { ...options, credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`Ending API: ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  async loadCast(runId) {
    if (!this.baseUrl) return null;
    try { return readCast(await this.request(`cast?exclude=${encodeURIComponent(runId)}`)); }
    catch { return null; }
  }

  capture(snapshot) {
    if (!this.baseUrl || snapshot.preview || !snapshot.decisions.length) return;
    const revision = `${snapshot.decisions.length}:${snapshot.outcome}`;
    if (this.captured.get(snapshot.runId) === revision) return;
    this.captured.set(snapshot.runId, revision);
    const submissionKey = this.tokens.get(snapshot.runId) ?? globalThis.crypto.randomUUID();
    this.tokens.set(snapshot.runId, submissionKey);
    this.queue = this.queue.filter(item => item.snapshot.runId !== snapshot.runId);
    this.queue.push({ snapshot, submissionKey });
    this.queue = this.queue.slice(-20);
    this.persist();
    this.flush();
  }

  persist() {
    try { this.storage?.setItem(STORE, JSON.stringify(this.queue)); } catch {}
  }

  async flush() {
    if (this.flushing || !this.baseUrl) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        const result = await this.request('runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item), keepalive: true });
        if (result?.stored !== true || result.runId !== item.snapshot.runId) break;
        this.queue = this.queue.filter(entry => entry !== item);
        this.persist();
      }
    } catch {}
    finally { this.flushing = false; }
  }
}
