// The policy table: rules of (role, upstream, method, path pattern), first match wins, a final deny.
// Every effect is "allow" unless the rule says "deny". A DELETE never matches: no rule lists one.
export function compile(policy) {
  const rules = policy.rules.map((r, i) => ({
    index: i,
    role: r.role,
    upstream: r.upstream,
    methods: new Set([].concat(r.method).map((m) => m.toUpperCase())),
    re: new RegExp(r.path),
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
