// The backend database's connection, from two secrets: the connection string (GATEWAY_DATABASE_URL, or the file
// GATEWAY_DATABASE_URL_FILE names) and the database server's CA certificate (GATEWAY_DATABASE_CA / _FILE). The
// CA is verified, always. pg merges a connection string's own parameters OVER the options passed beside it
// (lib/connection-parameters.js: `Object.assign({}, config, parse(config.connectionString))`): measured on pg 8.23.1,
// a URL with `sslmode=require` (the mode a managed database writes into its URL) replaces the ssl option with an
// empty one, so the CA pinned here is dropped and the system store decides, and `sslmode=no-verify` replaces it
// with no verification at all. So every ssl parameter is stripped from the URL here and the one ssl setting is
// ours: this CA, rejectUnauthorized true (test/database.test.js holds the measurement).
// A URL that is not postgres://, or names no host or no database, is refused at start, not at the first insert.
export function databaseConfig(url, ca) {
  if (typeof url !== 'string' || url.length === 0) throw new Error('database: the connection string is empty');
  if (typeof ca !== 'string' || !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error('database: the CA is not a PEM certificate');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('database: the connection string is not a URL'); }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) throw new Error(`database: the connection string must be postgres://, not ${parsed.protocol}`);
  if (!parsed.hostname) throw new Error('database: the connection string names no host');
  if (!parsed.pathname || parsed.pathname === '/') throw new Error('database: the connection string names no database');
  for (const key of [...parsed.searchParams.keys()]) if (/^ssl/i.test(key)) parsed.searchParams.delete(key);
  return { connectionString: parsed.toString(), ssl: { ca, rejectUnauthorized: true }, max: 2, application_name: 'cocoon-gateway' };
}
