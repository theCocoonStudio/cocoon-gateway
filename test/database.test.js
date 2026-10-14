import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { databaseConfig } from '../src/database.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';

test('the CA is verified whatever the connection string says: sslmode is stripped, our ssl setting is the one pg uses', () => {
  const cfg = databaseConfig('postgresql://writer:p%40ss@db.example:25060/gateway?sslmode=require', CA);
  assert.equal(cfg.connectionString, 'postgresql://writer:p%40ss@db.example:25060/gateway');
  assert.deepEqual(cfg.ssl, { ca: CA, rejectUnauthorized: true });
  // pg's own merge (connection-parameters.js) would let a URL's sslmode override the option; with the URL stripped it cannot
  const params = new pg.Client(cfg).connectionParameters;
  assert.equal(params.ssl.rejectUnauthorized, true);
  assert.equal(params.ssl.ca, CA);
  assert.equal(params.host, 'db.example');
  assert.equal(params.port, 25060);
  assert.equal(params.database, 'gateway');
  assert.equal(params.user, 'writer');
  assert.equal(params.application_name, 'cocoon-gateway');
});

test('what pg does with the URL as handed out, measured: sslmode=require drops the CA pinned beside it, no-verify drops verification', () => {
  const pinned = { ca: CA, rejectUnauthorized: true };
  const required = new pg.Client({ connectionString: 'postgresql://w:p@db.example:25060/gateway?sslmode=require', ssl: pinned }).connectionParameters;
  assert.equal(required.ssl.ca, undefined, 'the URL\'s sslmode replaced the ssl option with an empty one');
  const noVerify = new pg.Client({ connectionString: 'postgresql://w:p@db.example:25060/gateway?sslmode=no-verify', ssl: pinned }).connectionParameters;
  assert.equal(noVerify.ssl.rejectUnauthorized, false);
});

test('a connection string that is empty, not a URL, not postgres, or names no host or database is refused at start', () => {
  assert.throws(() => databaseConfig('', CA), /is empty/);
  assert.throws(() => databaseConfig('not a url', CA), /not a URL/);
  assert.throws(() => databaseConfig('mysql://u:p@h/db', CA), /must be postgres:\/\//);
  assert.throws(() => databaseConfig('postgres:///db', CA), /names no host/);
  assert.throws(() => databaseConfig('postgres://u:p@h:5432/', CA), /names no database/);
  assert.throws(() => databaseConfig('postgres://u:p@h:5432/db', 'not a pem'), /not a PEM certificate/);
});
