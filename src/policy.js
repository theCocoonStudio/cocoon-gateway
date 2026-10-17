// The policy table: rules of (role, upstream, method, path pattern), first match wins, a final deny.
// Every effect is "allow" unless the rule says "deny". A DELETE never matches: no rule lists one.
// `writable` names the repositories a write may reach (owner/name); a rule's path may carry the token
// `{writable}`, which compiles to that alternation. Every other repository is read-only through this gateway,
// the owner's own above all (2026-10-17): a write rule without the token would reach any repository the App
// is installed on.
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function compile(policy) {
  const writable = Array.isArray(policy.writable) ? policy.writable : [];
  const alternation = `(?:${writable.map(escapeRegExp).join('|')})`;
  const expand = (path) => {
    if (!path.includes('{writable}')) return path;
    if (writable.length === 0) throw new Error('policy: a rule uses {writable} and the table names no writable repository');
    return path.split('{writable}').join(alternation);
  };
  const rules = policy.rules.map((r, i) => ({
    index: i,
    role: r.role,
    upstream: r.upstream,
    methods: new Set([].concat(r.method).map((m) => m.toUpperCase())),
    re: new RegExp(expand(r.path)),
    effect: r.effect === 'deny' ? 'deny' : 'allow',
  }));
  return { roles: policy.roles, rules };
}

export function decide(compiled, role, upstream, method, path) {
  for (const rule of compiled.rules) {
    if (rule.role !== role || rule.upstream !== upstream) continue;
    if (!rule.methods.has(method.toUpperCase())) continue;
    if (!rule.re.test(path)) continue;
    return { allow: rule.effect === 'allow', rule: rule.index };
  }
  return { allow: false, rule: null }; // the final deny
}
