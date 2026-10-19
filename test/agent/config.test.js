import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRules } from '../../src/agent/config.js';

const good = (over = '') => `---\nmodel: claude-sonnet-5-5\nsay_bound: 280\nprompt_bound: 500\ncalls_per_turn: 8\nturn_seconds: 20\nturns_per_visit: 20\nvisit_minutes: 30\nspend_per_visit_usd: 0.10\nspend_per_day_usd: 5\nhistory_limit: 50\nretention_days: 30\nsnapshot_days: 90\nprice_input_per_million_usd: 3\nprice_output_per_million_usd: 15\nmax_tokens: 1024\n${over}---\n\nThe rules.\n`;

test('the rules file parses: the model, every number, the body as the system prompt', () => {
  const c = parseRules(good());
  assert.equal(c.model, 'claude-sonnet-5-5');
  assert.equal(c.sayBound, 280);
  assert.equal(c.spendPerVisitUsd, 0.1);
  assert.equal(c.priceOutput, 15);
  assert.equal(c.system, 'The rules.');
});

test('a missing number, a bad value, a duplicate, a non-integer count, an empty body and a zero price are refused', () => {
  assert.throws(() => parseRules(good().replace('say_bound: 280\n', '')), /say_bound is missing/);
  assert.throws(() => parseRules(good().replace('say_bound: 280', 'say_bound: many')), /non-negative number/);
  assert.throws(() => parseRules(good('say_bound: 1\n')), /given twice/);
  assert.throws(() => parseRules(good().replace('calls_per_turn: 8', 'calls_per_turn: 8.5')), /must be an integer/);
  assert.throws(() => parseRules(good().replace('The rules.', '')), /body .* is empty/);
  assert.throws(() => parseRules(good().replace('price_input_per_million_usd: 3', 'price_input_per_million_usd: 0')), /prices are zero/);
  assert.throws(() => parseRules('no front matter'), /open with a --- line/);
});

test('the repository\'s own rules file parses when zero prices are allowed, and refuses to start otherwise (the owner fills the prices at deploy)', () => {
  const text = fs.readFileSync(new URL('../../agent/rules.md', import.meta.url), 'utf8');
  const c = parseRules(text, { allowZeroPrices: true });
  assert.equal(c.sayBound, 280);
  assert.match(c.system, /agent over this page's scene/);
  assert.throws(() => parseRules(text), /prices are zero/);
});
