// The request log's sink: every line the gateway logs is inserted into the backend database. The owner,
// 2026-10-13: the log lives there, never on this host or on the sandbox's, because a machine's own record of
// itself is not a record (whatever reaches the host reaches its log), and the agent that wrote this deploy
// holds the best map of this host. In the database the gateway's credential inserts and never deletes, the
// owner reads, the agent does neither. stdout keeps a copy for the container's lifetime only.
//
// A bounded write-behind queue: lines are inserted in batches, at `batch` lines or after `flushMs`, whichever
// comes first; a failed insert keeps its lines, in order, and retries with a doubling delay capped at
// `maxBackoffMs`; a full queue (the database away for minutes) stops accepting, and the app refuses every new
// request with a 503 that says why (src/app.js): no log, no request. The owner may strike that for drop-and-count.
import { setTimeout as nodeSetTimeout, clearTimeout as nodeClearTimeout } from 'node:timers';

const REQUEST_COLUMNS = ['id', 'ts', 'role', 'upstream', 'method', 'path', 'status', 'ms', 'bytes', 'rule', 'peer'];
const REFUSAL_COLUMNS = ['id', 'ts', 'kind', 'host', 'role', 'upstream', 'method', 'path', 'status', 'detail', 'peer'];

// A line is a proxied request when the policy allowed it and the upstream answered or failed: it carries the rule
// and the duration (src/app.js onDone). Everything else is a refusal: misdirected, unauthenticated, policy,
// credential, log (this sink full), tls (a handshake the server refused; no request id exists for it).
export function tableOf(line) {
  if (line.tls !== undefined) return 'refusals';
  return line.rule !== undefined && line.ms !== undefined ? 'requests' : 'refusals';
}

export function rowOf(line) {
  if (tableOf(line) === 'requests') return [line.id, line.ts, line.role, line.upstream, line.method, line.path, line.status, line.ms, line.bytes ?? 0, line.rule, line.peer ?? null];
  if (line.tls !== undefined) return [null, line.ts, 'tls', null, null, null, null, null, null, line.tls, line.from ?? null];
  return [line.id ?? null, line.ts, line.kind ?? 'refused', line.host ?? null, line.role ?? null, line.upstream ?? null, line.method ?? null, line.path ?? null, line.status ?? null, line.detail ?? null, line.peer ?? null];
}

// One multi-row INSERT per table per batch, every value a parameter (pg allows 65535; a batch of 100 uses 1100).
export function insertStatement(table, rows) {
  const columns = table === 'requests' ? REQUEST_COLUMNS : REFUSAL_COLUMNS;
  const values = [];
  const tuples = rows.map((row) => `(${row.map((v) => { values.push(v); return `$${values.length}`; }).join(', ')})`);
  return { text: `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, values };
}

export function createSink({ query, flushMs = 1000, batch = 100, capacity = 10_000, maxBackoffMs = 30_000, report = (l) => console.log(JSON.stringify(l)), timers = { set: nodeSetTimeout, clear: nodeClearTimeout } }) {
  if (typeof query !== 'function') throw new Error('sink: a query function is required');
  const queue = [];
  const state = { inserted: 0, dropped: 0, failures: 0, lastError: null, lastFlushAt: null };
  let timer = null;
  let inFlight = null;
  let closed = false;
  const accepting = () => !closed && queue.length < capacity;
  const clearTimer = () => { if (timer) { timers.clear(timer); timer = null; } };
  const schedule = (ms) => { if (timer) return; timer = timers.set(() => { timer = null; flush(); }, ms); };

  async function insertAll() {
    while (queue.length > 0) {
      const table = tableOf(queue[0]);
      const take = [];
      while (take.length < batch && queue.length > 0 && tableOf(queue[0]) === table) take.push(queue.shift());
      try {
        const { text, values } = insertStatement(table, take.map(rowOf));
        await query(text, values);
        state.inserted += take.length;
        state.failures = 0;
        state.lastError = null;
        state.lastFlushAt = new Date().toISOString();
      } catch (err) {
        queue.unshift(...take); // kept, in order; nothing is dropped by a failure
        state.failures += 1;
        state.lastError = err.message;
        report({ ts: new Date().toISOString(), sink: 'insert failed', error: err.message, queued: queue.length, failures: state.failures });
        clearTimer();
        if (!closed) schedule(Math.min(flushMs * 2 ** state.failures, maxBackoffMs));
        return;
      }
    }
  }
  function flush() {
    if (!inFlight) inFlight = insertAll().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    // true when the line is queued; false when the queue is full or the sink is closed (counted as dropped).
    write(line) {
      if (!accepting()) { state.dropped += 1; return false; }
      queue.push(line);
      if (state.failures > 0) return true; // a retry is scheduled with its backoff; the line waits for it
      if (queue.length >= batch) { clearTimer(); flush(); } else schedule(flushMs);
      return true;
    },
    accepting,
    flush,
    // The start check: a connection and a round trip, with any grant. A failure here ends the start.
    async probe() { await query('SELECT 1'); },
    state() { return { ...state, queued: queue.length, accepting: accepting() }; },
    async close() { closed = true; clearTimer(); await flush(); },
  };
}
