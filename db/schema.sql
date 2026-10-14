-- The request log's two tables, applied once by the OWNER's credential (psql against the managed database).
-- The gateway never creates or alters anything: its own credential holds INSERT on these two tables and
-- nothing else (the grant below), so the process that writes the log cannot read, change or erase it, and
-- neither can anyone holding the Droplet, where only that credential lives. (the owner, 2026-10-13)
CREATE TABLE IF NOT EXISTS requests (
  id          uuid        NOT NULL,            -- the request id, also in the x-request-id header and the sandbox relay's log
  ts          timestamptz NOT NULL,            -- when the gateway logged it (the upstream had answered)
  role        text        NOT NULL,            -- the client certificate's common name
  upstream    text        NOT NULL,            -- the subdomain's key in config/upstreams.json
  method      text        NOT NULL,
  path        text        NOT NULL,            -- as sent upstream, after the rewrite
  status      integer     NOT NULL,            -- the upstream's, or 502 when it failed
  ms          integer     NOT NULL,
  bytes       bigint      NOT NULL,            -- the response body, down; the request body is not counted (src/proxy.js)
  rule        integer     NOT NULL,            -- the index of the policy rule that allowed it
  peer        text,                            -- the client's address as the gateway saw it (the relay's host)
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS refusals (
  id          uuid,                            -- null for a TLS failure: no request exists yet
  ts          timestamptz NOT NULL,
  kind        text        NOT NULL,            -- misdirected | unauthenticated | policy | credential | log | tls
  host        text,                            -- the Host header as received
  role        text,
  upstream    text,
  method      text,
  path        text,
  status      integer,
  detail      text,                            -- the body's detail, or the TLS error
  peer        text,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
CREATE INDEX IF NOT EXISTS refusals_ts ON refusals (ts);

-- The gateway's credential: insert-only, no SELECT, no UPDATE, no DELETE, no DDL. Run as the owner, with the
-- password you choose; the connection string the Droplet gets (database.url) is this role's.
-- CREATE ROLE gateway_writer LOGIN PASSWORD '<a long random password>';
-- GRANT CONNECT ON DATABASE <the database> TO gateway_writer;
-- GRANT USAGE ON SCHEMA public TO gateway_writer;
-- GRANT INSERT ON requests, refusals TO gateway_writer;
