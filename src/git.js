// The receive-pack command list, read before a push is passed through (2026-10-19). git's smart HTTP push
// opens its body with pkt-lines, one per ref the client wants to update: `old-id SP new-id SP ref-name`,
// the first with a NUL and the client's capabilities after the name, then a flush-pkt (`0000`), then the pack
// (or nothing, when every command is a deletion). The gateway reads up to that flush, bounded, and decides
// on what it names: a deletion (a new-id of forty zeros) is refused for every role, since the policy table's
// absence of a DELETE method never reached refs (a branch deletion is a push; copula #4's branch went that
// way on 2026-10-17); a signed push (`push-cert` among the capabilities) is refused too, since it carries its
// commands inside a certificate this reader does not parse. A force push cannot be told here: whether new-id
// descends from old-id needs the objects, which this gateway never has; the rulesets refuse it on main.
// Shallow lines (`shallow SP obj-id`) before the commands are tolerated; push-option lines come after the
// flush and are not read.
const ZERO = '0'.repeat(40);
const ID = /^[0-9a-f]{40}$/;

/**
 * Parse the start of a receive-pack body. Returns { commands, capabilities, end } once the flush-pkt is in
 * `buf` (`end` is the byte offset after it), { incomplete: true } when more bytes are needed, or throws on a
 * body that is not a command list.
 */
export function parseReceivePackHead(buf) {
  const commands = [];
  let capabilities = [];
  let at = 0;
  for (;;) {
    if (buf.length < at + 4) return { incomplete: true };
    const len = parseInt(buf.toString('latin1', at, at + 4), 16);
    if (Number.isNaN(len)) throw new Error('a pkt-line length that is not hexadecimal');
    if (len === 0) return { commands, capabilities, end: at + 4 }; // flush-pkt
    if (len < 4) throw new Error(`a pkt-line of length ${len}`);
    if (buf.length < at + len) return { incomplete: true };
    let line = buf.toString('utf8', at + 4, at + len);
    at += len;
    if (line.endsWith('\n')) line = line.slice(0, -1);
    const nul = line.indexOf('\0');
    if (nul !== -1) {
      if (commands.length) throw new Error('capabilities after the first command');
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    if (line.startsWith('shallow ')) continue;
    const parts = line.split(' ');
    if (parts.length !== 3 || !ID.test(parts[0]) || !ID.test(parts[1]) || !parts[2].startsWith('refs/')) throw new Error(`a line that is not a ref command: ${JSON.stringify(line.slice(0, 80))}`);
    commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
  }
}

/** The verdict on a parsed head: null when it passes, else the reason it is refused. */
export function refuseReceivePack({ commands, capabilities }) {
  if (capabilities.some((c) => c === 'push-cert' || c.startsWith('push-cert='))) return 'a signed push (push-cert) carries its commands inside a certificate this gateway does not read; push unsigned';
  const deletion = commands.find((c) => c.new === ZERO);
  if (deletion) return `ref deletions never pass this gateway (${deletion.ref}); a branch is deleted by the owner's hand`;
  if (commands.length === 0) return 'a push with no ref command';
  return null;
}

/**
 * Read a request's body up to the end of the receive-pack command list, at most `cap` bytes, leaving the rest
 * unread for the pass-through. Resolves { head, ended, parsed }: `head` holds every byte read, `ended` says the
 * request body ended inside it (a push of deletions alone sends no pack), `parsed` is parseReceivePackHead's.
 * Rejects on a body that is not a command list, or one whose list exceeds the cap.
 */
export function readReceivePackHead(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); fn(); };
    const onData = (c) => {
      chunks.push(c); size += c.length;
      const head = Buffer.concat(chunks);
      let parsed;
      try { parsed = parseReceivePackHead(head); } catch (err) { return finish(() => { req.resume(); reject(err); }); }
      if (parsed.incomplete) {
        if (size > cap) finish(() => { req.resume(); reject(new Error(`the receive-pack command list exceeds ${cap} bytes`)); });
        return;
      }
      finish(() => { req.pause(); resolve({ head, ended: false, parsed }); });
    };
    const onEnd = () => {
      const head = Buffer.concat(chunks);
      let parsed;
      try { parsed = parseReceivePackHead(head); } catch (err) { return finish(() => reject(err)); }
      if (parsed.incomplete) return finish(() => reject(new Error('the push body ended before its command list did')));
      finish(() => resolve({ head, ended: true, parsed }));
    };
    const onError = (err) => finish(() => reject(err));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}
