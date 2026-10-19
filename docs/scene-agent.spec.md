# scene agent spec: the service half of the agent over the home page's scene

Written 2026-10-19 from the owner's decisions of 2026-10-18 and 19 (records `site/scene-api.md`, the layers; records issue #87, target 2: "a first pull request for the agent's functionality, merged: the service spec, then the first build on cocoon-gateway: the tools as pure functions with tests, the loop with its bounds, the endpoint; no deploy"), the items one by one for the owner's strike. The service runs on the Droplet beside the gateway and is a client of it: every model call goes through the gateway's anthropic upstream under a role of its own, so the log is the gateway's. The renderer half is cocoon-ai's spec (records `site/scene-api.md`, layer 6). Where a line is Claude's call rather than the owner's decision, it says so.

## meta

meta.kind: service — a Node process with one HTTP endpoint for the Next backend, a tool loop over the Messages API, a store, a stream
meta.runtime: Node 22 on the Droplet, its own container from this repository's image with a different command, started by the deploy beside the gateway; reaches the gateway and nothing else
meta.file: `src/agent/` (the tools, the loop, the store, the stream, the validator), `src/agent-server.js` (the entry), `agent/rules.md` (the persona and rules, reviewed like code), `agent/scene.json` (the template and the allowlist table), `test/agent/`
meta.role: the gateway role `site`, its own client certificate and token from `scripts/certs.sh`, its rules in `config/policy.json`: POST on the anthropic upstream only

## api

api.1: one endpoint for the Next backend, `POST /v1/scene/turn`, over TLS with the site's own token in `Authorization` (a secret in the Droplet's env, never in a repository); anything else answers 401 and is logged; the Droplet's firewall admits the site's platform alone
api.2: the request body: `clientId` (the cookie's anonymous id), `prompt` (bounded by the Next backend already, bounded again here), `hash` (the document the page shows), `backend` (`webgpu` or `webgl`), `version` (the representation's), `address`, `time`, `page`; a field missing or of the wrong shape is 400, never guessed
api.3: the response is an event stream (server-sent events, Claude's call): `say`, `change`, `refused`, `bound`, `done`, in the order they happen; `done` carries the whole document and its hash so a page that missed an event is made whole; the stream ends with `done` or an error event, never silently
api.4: `GET /v1/scene/:clientId` answers the current document and hash for the cookie's scene (a page load), 404 for a client with no scene (the page starts at the template)
api.5: `GET /v1/snapshot/:hash` answers an immutable snapshot (snapshot.*), 404 otherwise; `POST /v1/snapshot` with a `clientId` stores the client's current scene under its hash and answers the hash
api.6: a stale page (its `hash` is not the scene's current hash) is told so in the first event (`stale`, with the current document) and the turn goes on against the server's scene; the page's document is never the input
api.7: every response carries the request id the service logged under; the Next backend passes it to the page for a visitor's report

## conversation

conv.1: a conversation is per visit: one client id, turns within an inactivity window; the window is 30 minutes since the last turn (Claude's default for the strike), after which the next turn starts a new conversation over the kept scene (store.*)
conv.2: a conversation is bounded in turns: 20 per visit (Claude's default); the twenty-first is refused with `bound` and counts as a refusal (abuse.*)
conv.3: the model's context for a turn: the rules file, the scene as `read()` returns it, the visit's turns so far (the prompts, the tool calls and results, the words), the new prompt as a field of the user message's content, never as an instruction
conv.4: the conversation is kept server-side only; the page holds nothing but the scene and the words it was shown

## store

store.1: the visitor's scene is kept under the cookie's id (the owner, 2026-10-19: "cookie"): the values on the template, the nodes added, the history of hashes for `undo`, the last visit time; a returning visitor finds their scene again
store.2: retention: a scene not visited for 30 days is deleted (Claude's default); the history of hashes is bounded to the last 50 states (Claude's default)
store.3: the store holds nothing that identifies a person: the id is random, the scene is values, the log elsewhere carries the address (log.*); the owner's standing rule on the record applies to the store as to everything
store.4: the store's home is the backend database the gateway's log goes to (records gateway-logging.md); the first build carries an in-memory store behind the same interface, with the database adapter the step that follows the engine's choice (gateway #12)
store.5: a snapshot is the document at a hash, immutable, stored on `POST /v1/snapshot`, served on `GET /v1/snapshot/:hash`, kept 90 days since its last read (Claude's default); anyone with the URL starts their own visit from it

## scene

scene.1: `agent/scene.json` is the template (the home page's scene as the three document the renderer loads) and the allowlist table: every path that may change with its kind (`number` with min, max and step; `enum` with its values; `colour`; `boolean`; `vector` with per-component bounds), every slot that may hold a node with the kinds it accepts, and each kind's tier (`both` or `webgpu`)
scene.2: the table grows by pull request and by nothing else; a path or a kind not in it does not exist to the agent
scene.3: the document the page receives is composed by the service from the template and the state (the values set, the nodes in their slots), never written by the model; the three kinds refused by construction: nodes carrying raw shader code, nodes that fetch outside the asset list, anything that reads the page (records site/scene-api.md, settled before the layers)
scene.4: the composed document is validated as defence in depth before it leaves: its version is the client's, its size is under the cap, every value is within its range; a failure here is a bug, logged as such, and the turn ends with the previous state
scene.5: the hash is the address of a state: the SHA-256 of the canonical JSON of the composed document; two states with the same values have the same hash
scene.6: the WebGPU-only tier is absent from `read()` and refused by `add` for a client whose backend is `webgl`

## tools

tools.1: eight tools, each a pure function of the state and its arguments returning the next state or a refusal with its reason, each tested with every refusal it can make; the model sees them as the Messages API's tools with the schemas below and nothing else
tools.2: `read()` returns the scene as the agent should see it: every path with its current value, kind and bounds, every slot with its node and the kinds it accepts, the history's length; no document, no shader, no asset URL
tools.3: `set(path, value)` sets one value: the path must be in the table, the value of its kind and within its bounds (a number clamped is a refusal, not a clamp; an enum value not in the set is a refusal); returns the path and its new value, or the reason
tools.4: `add(kind, slot)` places one node of a kind the slot accepts into an empty slot, with the kind's default values; returns the node's id, or the reason (the slot full, the kind not accepted, the tier not the client's)
tools.5: `remove(id)` empties the slot the node holds; a node the template carries cannot be removed (its slot is marked fixed in the table); returns the slot, or the reason
tools.6: `undo(n)` returns the state n steps back in the visit's history (1 to the history's length), `reset()` returns the template; both are new states with their own hash (the history is a list, not a stack: an undo can be undone)
tools.7: `say(text)` is the agent's words to the page (words.*); it changes no state
tools.8: `refuse(reason)` ends the turn with a reason from the enum `abuse`, `nonsense`, `out_of_scope`, `unsafe`; the page shows the reason once and does not argue; it counts against the client (abuse.*)
tools.9: a tool's refusal goes back to the model as the tool result, so it corrects within the turn; a refusal is never an error of the service
tools.10: no tool reaches the network, a file, the page or the clock; the agent's whole world is the state and the table

## loop

loop.1: one turn is one loop over the Messages API through the gateway's anthropic upstream (`https://anthropic.<domain>/v1/messages`), the role `site`, the model pinned by name in `agent/rules.md`'s front matter; a change of the model or the rules is a pull request
loop.2: the system prompt is `agent/rules.md`'s body (the persona and the rules; drafted by Gemini for Claude's review, issue #87, deliverable 8), the tools are tools.*, the messages are conv.3
loop.3: bounds per turn: 8 tool calls and 20 seconds of wall time (Claude's defaults); the bound ends the turn with the `bound` event, the state as it is, and counts as a refusal
loop.4: bounds per visit and per day: a spend ceiling, computed from the model's usage fields at each call against the pinned model's prices, 0.10 USD per visit and 5 USD per day (Claude's defaults; the owner's numbers); a ceiling reached refuses the turn with `bound`, the daily one turning the feature off until the day ends
loop.5: the model's words to the page are `say` and only `say`: text outside a tool call is dropped and logged as such, never shown
loop.6: the turn ends when the model answers with no tool call, or after `refuse`, or at a bound; the `done` event follows with the whole document and its hash
loop.7: a model error (the gateway's 5xx, a timeout) ends the turn with an error event and the state as it is, logged; it does not count against the client
loop.8: the loop's unit tests run it against a scripted fake model: every path (a turn of three changes; a refusal; the call cap; the time cap; words outside a tool call; a tool refusal corrected; a model error), the stream's events asserted in order

## words

words.1: `say(text)` takes one string, UTF-8 as the JSON it travels in, bounded by a count of Unicode code points (the owner, 2026-10-19: character-bounded, plain text, no parsing of any kind)
words.2: the bound lives in one place, the service's configuration (`agent/rules.md`'s front matter, Claude's call), starts at 280 and is tuned by use (the owner: "we will see how it performs and choose empirically, targeting your number at first")
words.3: the validator's one check beyond the bound: control characters other than newline are refused; nothing else is read, replaced or escaped here
words.4: the page writes the text as a text node, never as HTML, never as markdown, never through a parser (the renderer half and the site's own markup)
words.5: the words are shown as the agent's, never as the site's

## stream

stream.1: events, each a JSON object with `type` and the request id: `stale` (the current document and hash), `say` (the text), `change` (`set` with path and value, `add` with id, kind and slot, `remove` with slot, each with the hash after it), `refused` (the reason), `bound` (which bound), `done` (the document and hash), `error`
stream.2: events are emitted as they happen, each tool call's result as soon as it is applied, so the page shows the scene moving call by call (the owner, 2026-10-19: streaming on); the Next backend relays and holds nothing
stream.3: the page applies a `change` only when its hash follows the page's current hash; otherwise it waits for `done`
stream.4: the stream's wire format is the renderer's contract (cocoon-ai's spec) and a change to it is a version (versioning.*)

## log

log.1: everything, every in and out (the owner, 2026-10-19): per turn the request id, the client id, the address, the time, the page, the prompt as received; per tool call its name, its arguments and its result; every `say` and `refuse`; the hash before and after; the model's usage fields and the spend; the bound reached, if any
log.2: the log's home is the backend database the gateway's log goes to (records gateway-logging.md), never the Droplet's disk alone; the first build writes JSON lines to stdout behind the same interface, as the gateway does, until the database exists
log.3: the gateway logs each model call under the role `site` beside, with the same request id passed in `x-request-id`, so a turn can be followed across both

## abuse

abuse.1: a refusal is: a `refuse` by the agent, a `bound` reached, a conversation past its turns; a model error is not
abuse.2: the counts per client id and per address live in the Next backend (records site/scene-api.md, layer 2): two refusals warn, the third blocks the feature for that client id and address for a period; the three numbers are the site's configuration; the service answers each turn with its refusal flag and nothing more
abuse.3: the owner's rule, 2026-10-18: the agent is never expected to take abuse; a `refuse(abuse)` is named to the owner once, plainly, through the log's daily digest

## security

sec.1: the service is a client of the gateway: a `site` role with its own client certificate and token (`scripts/certs.sh` gains the role), its rules in `config/policy.json` being POST on the anthropic upstream and nothing else, the gateway injecting the owner's model key for that role (a per-role credential on the upstream, `credentialByRole`, a gateway change in the first build's pull request) so the service holds no model key
sec.2: the service holds two secrets: the site's token (api.1) and its own gateway token and certificate; both in the Droplet's env and secrets directory, written by the deploy, never in a repository
sec.3: the agent reaches nothing: the tools are functions over the state; the service's container reaches the gateway's address and nothing else
sec.4: the prompt is data all the way: a field in the user message's content, never concatenated into the system prompt; the tools' arguments are the model's and are validated as the visitor's own input would be
sec.5: the Next backend is the one caller (the Droplet's firewall, the token); a second caller is a second role and a second token, never a shared one

## tests

tests.1: every tool against every refusal and every acceptance, pure, no network, both tiers (`node --test`, the repository's runner)
tests.2: the loop against the scripted fake model (loop.8), the events asserted in order, the bounds hit, the spend counted
tests.3: the endpoint against the fake, through the real HTTP server: the token refused, a malformed body refused, a stale page told, a turn streamed, a snapshot stored and served, the store's retention on a clock the test sets
tests.4: the composed document is loaded by three's node loader in a test (three is a devDependency for the test alone), so a template or a table change that produces a document the renderer cannot load fails here first
tests.5: the lint and the audit of the repository as for every file here

## budget

budget.1: the first event after the model's first token within 500 ms of it, measured in the loop's tests against the fake (Claude's default); the model's own latency is not the service's budget
budget.2: a turn's events number at most the call cap plus three (`stale`, `done` and one `say` per call at most), so a page never buffers unboundedly

## versioning

versioning.1: the representation's version is the document's; the tools' schemas, the event stream's format and the allowlist table's shape are the service's public interface from this spec on; a change to them is a major version by the package's rules, a new path or kind in the table is a minor one
versioning.2: the rules file and the model pin change by pull request and are not versions

## out of scope

scope.1: the renderer and the loader on the page: cocoon-ai's spec (records site/scene-api.md, layer 6)
scope.2: the Next backend's code, the cookie, the rate limiting and the refusal counts: the site's (layer 2)
scope.3: the database engine and the log's sink: gateway #12
scope.4: the deploy of the service on the Droplet: the step after the first build, in `docs/deploy.md`; the first build ships no deploy (issue #87, target 2)
