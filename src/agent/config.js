// The agent's configuration: agent/rules.md's front matter (flat `key: value` lines between two `---` lines),
// the body being the system prompt (docs/scene-agent.spec.md, loop.1, loop.2, words.2). Every number the
// service runs on is here and nowhere else, but the two prices: a missing or malformed line refuses the start,
// and so does a price of zero unless the caller takes the prices on itself (`allowZeroPrices`), as the entry
// does from the environment at deploy (src/agent-server.js), since a spend ceiling counted against zero never fires.
const NUMBERS = {
  say_bound: 'sayBound', prompt_bound: 'promptBound', calls_per_turn: 'callsPerTurn', turn_seconds: 'turnSeconds',
  turns_per_visit: 'turnsPerVisit', visit_minutes: 'visitMinutes', spend_per_visit_usd: 'spendPerVisitUsd',
  spend_per_day_usd: 'spendPerDayUsd', history_limit: 'historyLimit', retention_days: 'retentionDays',
  snapshot_days: 'snapshotDays', price_input_per_million_usd: 'priceInput', price_output_per_million_usd: 'priceOutput',
  max_tokens: 'maxTokens',
};

export function parseRules(text, { allowZeroPrices = false } = {}) {
  const lines = text.split('\n');
  if (lines[0] !== '---') throw new Error('rules: the file must open with a --- line');
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error('rules: the front matter never closes');
  const raw = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([a-z][a-z0-9_]*):\s*(\S.*)$/);
    if (!m) throw new Error(`rules:${i + 1}: not a \`key: value\` line`);
    if (m[1] in raw) throw new Error(`rules:${i + 1}: ${m[1]} is given twice`);
    raw[m[1]] = m[2].trim();
  }
  if (!raw.model || !/^[a-z0-9.-]+$/.test(raw.model)) throw new Error('rules: model must name the pinned model');
  const config = { model: raw.model };
  for (const [key, name] of Object.entries(NUMBERS)) {
    if (!(key in raw)) throw new Error(`rules: ${key} is missing`);
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 0) throw new Error(`rules: ${key} must be a non-negative number`);
    config[name] = n;
  }
  for (const key of ['sayBound', 'promptBound', 'callsPerTurn', 'turnsPerVisit', 'historyLimit', 'maxTokens'])
    if (!Number.isInteger(config[key])) throw new Error(`rules: ${key} must be an integer`);
  if (!allowZeroPrices && (config.priceInput === 0 || config.priceOutput === 0))
    throw new Error('rules: the two prices are zero; fill them from the model\'s price page, or the spend ceiling never fires');
  config.system = lines.slice(end + 1).join('\n').trim();
  if (!config.system) throw new Error('rules: the body (the system prompt) is empty');
  return config;
}
