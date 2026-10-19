import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceivePackHead, refuseReceivePack } from '../src/git.js';

const pkt = (s) => (Buffer.byteLength(s) + 4).toString(16).padStart(4, '0') + s;
const SHA = (c) => c.repeat(40);

test('a command list parses to its commands and capabilities, the flush ending it', () => {
  const body = pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\0report-status side-band-64k\n`) + pkt(`${SHA('0')} ${SHA('c')} refs/tags/v1\n`) + '0000PACK';
  const p = parseReceivePackHead(Buffer.from(body));
  assert.deepEqual(p.commands, [{ old: SHA('a'), new: SHA('b'), ref: 'refs/heads/main' }, { old: SHA('0'), new: SHA('c'), ref: 'refs/tags/v1' }]);
  assert.deepEqual(p.capabilities, ['report-status', 'side-band-64k']);
  assert.equal(body.slice(p.end), 'PACK');
  assert.equal(refuseReceivePack(p), null);
});

test('a list without its flush is incomplete; shallow lines are skipped', () => {
  assert.deepEqual(parseReceivePackHead(Buffer.from(pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\n`))), { incomplete: true });
  assert.deepEqual(parseReceivePackHead(Buffer.from('00')), { incomplete: true });
  const p = parseReceivePackHead(Buffer.from(pkt(`shallow ${SHA('d')}`) + pkt(`${SHA('a')} ${SHA('b')} refs/heads/main\n`) + '0000'));
  assert.equal(p.commands.length, 1);
});

test('what is not a command list throws, naming the line', () => {
  assert.throws(() => parseReceivePackHead(Buffer.from('zzzz')), /not hexadecimal/);
  assert.throws(() => parseReceivePackHead(Buffer.from('0003')), /length 3/);
  assert.throws(() => parseReceivePackHead(Buffer.from(pkt('hello world') + '0000')), /not a ref command/);
  assert.throws(() => parseReceivePackHead(Buffer.from(pkt(`${SHA('a')} ${SHA('b')} main\n`) + '0000')), /not a ref command/);
  assert.throws(() => parseReceivePackHead(Buffer.from(pkt(`${SHA('a')} ${SHA('b')} refs/heads/a\n`) + pkt(`${SHA('a')} ${SHA('b')} refs/heads/b\0caps\n`) + '0000')), /capabilities after the first command/);
});

test('the verdict: a deletion, a signed push and an empty list are refused; a creation and an update pass', () => {
  assert.match(refuseReceivePack({ commands: [{ old: SHA('a'), new: SHA('0'), ref: 'refs/heads/x' }], capabilities: [] }), /ref deletions never pass this gateway \(refs\/heads\/x\)/);
  assert.match(refuseReceivePack({ commands: [{ old: SHA('a'), new: SHA('b'), ref: 'refs/heads/x' }], capabilities: ['push-cert=nonce'] }), /signed push/);
  assert.match(refuseReceivePack({ commands: [{ old: SHA('a'), new: SHA('b'), ref: 'refs/heads/x' }], capabilities: ['push-cert'] }), /signed push/);
  assert.match(refuseReceivePack({ commands: [], capabilities: [] }), /no ref command/);
  assert.equal(refuseReceivePack({ commands: [{ old: SHA('0'), new: SHA('b'), ref: 'refs/heads/x' }, { old: SHA('a'), new: SHA('c'), ref: 'refs/heads/y' }], capabilities: ['report-status'] }), null);
});
