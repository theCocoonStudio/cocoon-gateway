// The store (docs/scene-agent.spec.md, store.*, conv.*): the visitor's scene under the cookie's id with its
// last visit, the visit's conversation with its inactivity window, snapshots by hash, the spend per visit and
// per day. This is the in-memory form behind the interface the database adapter will implement once the
// engine exists (gateway #12); it holds nothing that identifies a person (store.3). The clock is injected so
// the tests set it.
export function createMemoryStore({ now = () => Date.now(), visitMs, retentionMs, snapshotMs }) {
  const scenes = new Map(); // clientId -> { state, lastSeen }
  const conversations = new Map(); // clientId -> { messages, turns, startedAt, lastTurnAt, spend }
  const snapshots = new Map(); // hash -> { document, lastRead }
  const days = new Map(); // yyyy-mm-dd -> spend
  const day = (t) => new Date(t).toISOString().slice(0, 10);
  return {
    getScene(clientId) { const s = scenes.get(clientId); return s ? s.state : null; },
    putScene(clientId, state) { scenes.set(clientId, { state, lastSeen: now() }); },
    /** The visit's conversation, or a fresh one when none exists or the window has passed since the last turn. */
    getConversation(clientId) {
      const c = conversations.get(clientId);
      if (c && now() - c.lastTurnAt <= visitMs) return c;
      return { messages: [], turns: 0, startedAt: now(), lastTurnAt: now(), spend: 0 };
    },
    putConversation(clientId, conversation) { conversations.set(clientId, { ...conversation, lastTurnAt: now() }); },
    addSpend(clientId, usd) {
      const c = conversations.get(clientId);
      if (c) c.spend += usd;
      const d = day(now());
      days.set(d, (days.get(d) || 0) + usd);
    },
    spendOfDay() { return days.get(day(now())) || 0; },
    putSnapshot(hash, document) { snapshots.set(hash, { document, lastRead: now() }); },
    getSnapshot(hash) { const s = snapshots.get(hash); if (!s) return null; s.lastRead = now(); return s.document; },
    /** Retention: scenes not seen for retentionMs and snapshots not read for snapshotMs are deleted; the counts returned. */
    sweep() {
      let scenesGone = 0; let snapshotsGone = 0;
      for (const [id, s] of scenes) if (now() - s.lastSeen > retentionMs) { scenes.delete(id); conversations.delete(id); scenesGone += 1; }
      for (const [hash, s] of snapshots) if (now() - s.lastRead > snapshotMs) { snapshots.delete(hash); snapshotsGone += 1; }
      return { scenesGone, snapshotsGone };
    },
    size() { return { scenes: scenes.size, conversations: conversations.size, snapshots: snapshots.size }; },
  };
}
