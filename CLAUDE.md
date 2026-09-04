# fleetview

FleetView is a local, read-only viewer for agent-fleet run state. It renders three things
from a fleet directory on disk: each run's work graph (drawn from that run's own
`state.json`, with a live activity lane when the fleet writes one), the node roster (read
live from agent frontmatter), and the portfolio graph (from the fleet's registry index). It is a viewer and nothing else — it never writes to a
run, and it has no opinion about one.

Standalone app under the repos/ umbrella. Never import from a sibling app; see ../graph_agents/CLAUDE.md.

## Run it

```bash
python fleetview/serve.py                      # auto-detect a fleet, open a browser
python fleetview/serve.py --fleet ../somewhere/graph_agents
python fleetview/serve.py --port 8788 --no-open
```

No dependencies, no build step, no install: Python 3 stdlib only, and the page loads no
external resources.

```bash
node fleetview/test.js
```

Node is needed only to run the test suite, not the app itself — see Testing below.

## Architecture

Two files. `serve.py` is an `http.server` with exactly two routes: `/` returns
`index.html`, and `/api/graph` returns a JSON snapshot assembled from disk **on every
request** (so a run that is still executing updates on Refresh — there is no cache to
invalidate and no state held between requests). `index.html` is a self-contained page:
vanilla JS, no framework, no CDN. It fetches `/api/graph` once on load and re-renders
everything from that payload.

`/api/graph` is a **conditional request**. Every 200 carries a strong `ETag`: a SHA-256 of
the response's content with `generated` removed — that field is stamped per request and
would otherwise make every ETag unique and the whole mechanism dead. (`serve.py` pops
`generated`, hashes the rest, then re-adds it, so the hashed serialization is not a
substring of the shipped body. Correctness is unaffected — the client reads by key — but do
not describe the token as "the bytes that response ships".) The page keeps the last
ETag and sends it back as `If-None-Match`; a request that matches gets **304 with no body**,
and the 304 lands on the nothing-changed path that already existed in `load()` — `DATA`,
`FLEETS` and `ACTIVE_FLEET` are left untouched, the read-at stamp moves, the next poll is
scheduled, nothing re-renders. **Only the silent 4s poll asks conditionally.** An explicit
user action — Refresh, a fleet switch — sends no `If-None-Match` and so always gets a 200
and a full re-render, because "rebuild the page now" is exactly what that button means and a
304 would silently take it away. The poll is the request that repeats, so confining the
conditional there costs nothing. Optional in both directions: an old server sends no ETag, the
page stores none, and every request is a plain 200. The token is a **content hash and
deliberately not an mtime** — mtime granularity admits a *false* 304 on a sub-second write,
and a false 304 is a live view frozen forever, which is the one failure this app exists to
prevent. It adds no server state: the token is recomputed from disk on every request and the
client holds the only copy, so "no cache to invalidate" above still holds literally. The
fleet a request asked for is inside the hashed bytes, so one fleet's ETag can never match
another's payload. `Cache-Control: no-store` stays on both responses and does not fight it —
the page revalidates by hand rather than letting the browser cache decide.

What 304 does **not** fix is size. First load, a fleet switch, Refresh and every *changed*
poll still ship every run in full — ~700 KB at 9 runs, and it grows with run count. That is
accepted, not overlooked. **Revisit at ~40 runs or ~2 MB**, and note where that revisit has
to start: the only shape that stops the growth is a light run list plus a per-run fetch, and
it cannot be built without first amending "node/node click selection never triggers a
refetch" under Constraints. Archiving old runs out of `.graph/runs/` solves the same problem
at zero cost to FleetView.

Graph edges are drawn as SVG paths measured from the laid-out DOM after
`requestAnimationFrame`, not from a hardcoded coordinate table — the CSS decides geometry
and the edges follow, which is why the graph reflows correctly at any width.

State lives on disk in the fleet, never here. The only thing FleetView persists is one
`localStorage` key, `fleetview.anon`, for the Anonymize toggle.

Client-side state beyond `DATA` itself: `FLEETS`/`ACTIVE_FLEET` (the registered fleets and
which one is selected), `selectedRun`/`selectedNode`, `runFilter` (the search box), and
`currentView` (which tab is showing — tracked as a variable, not read back from the DOM, so
the router never depends on `document.querySelector`). The URL fragment
(`#runs?fleet=<id>&run=<id>&node=<id>`, or `#portfolio` / `#roster`) is a *view* onto that
state, kept in sync by `pushHash()` (a real, reachable navigation: switching runs or tabs)
and `replaceHash()` (a frequent, exploratory one: selecting a node) — see `parseHash`,
`buildHash`, `activateView` in the script. `popstate` re-applies the hash without a refetch
unless the fleet id in it differs from the one currently loaded.

The **activity lane** (`collect_activity` in `serve.py`, `renderActivity` in `index.html`)
reads an optional `activity.jsonl` beside a run's `state.json` — one JSON object per line,
appended by the fleet's hooks as nodes start, call tools and stop. `state.json` says what
each node *concluded*; this says what the nodes *did*, and it is the only thing here that
moves while a run is still running. It is **optional in both directions**: a fleet that
writes no heartbeat, or a run older than one, renders no lane rather than an empty one,
and FleetView never writes the file. The payload carries a per-agent summary plus the last
40 events, not the whole log — a long run is thousands of lines and shipping all of them on
every 4s poll would make the payload the slowest thing in the app. An unparseable line is
counted and skipped, because a hook may be mid-append when the request lands.

Three fields the fleet has always written are rendered as **decided signals, never as the
raw value** — each one reads backwards if you show it literally, and the filter is the
feature:

- **`_mtime`** → "state written 4m ago" in the run detail header. Never worded as *idle*:
  a node writes `state.json` only when it finishes, while `activity.jsonl` moves the whole
  time it is thinking, so a quiet `state.json` mid-node is the normal case. What earns a
  loud mark is both clocks stopping at once on a run whose `status` says a node should be
  working — a **wedged run**, which `status` alone cannot show (`wedgedFor`, 15 minutes on
  both). `awaiting-approval` is excluded (`WAITING_ON_A_HUMAN`): a run parked at the gate
  has both clocks stopped *by design* because it is blocked on a person, and flagging it
  would put a red pill on every gated run and teach the reader to ignore the real one. Do
  not add a status to that list unless it too waits on a human. A fleet that writes no
  heartbeat has only one clock, so nothing is claimed.
- **`scope_exceptions`** → a warning block, shown only when an entry is a **real path**
  (`isRealPath`). Neither `len()` nor a contains-a-slash test works on real data: a fresh
  run copies the schema's `ORCHESTRATOR-OWNED…` docstring into the array, so an untouched
  run looks like it granted one exception, and the orchestrator's mandatory `WHY (…)`
  rationale quotes the very globs it explains, so it reads as a path. Nor is "has no
  spaces" the answer — `huntstack/apps/My App/src/x.ts` is a grantable path, and dropping
  it under-reports exactly what the block exists to surface. The test is prose *shape*:
  the two prose forms announce themselves in their first word, and beyond that a sentence
  is long, punctuated and made of clauses while a path is short and made of segments. A
  `scope_exceptions` that is not a list at all renders as a stated malformed-input banner,
  not a throw that would truncate the run detail to its header.
- **`written_by`** → a provenance mark under each graph node, with **four states**. Stamped
  with the node that owns the key → *silent*. Missing → muted "unstamped (legacy)"; runs
  before 2026-08-26 predate the field and it is never an alarm. Still holding the schema
  placeholder (`the node that wrote this key…`) → muted "unstamped (did not run)", and it
  must be tested **before** the equality check, since the placeholder sentence contains the
  node name it stands in for. Only a stamp naming a **different** node is loud — that is the
  forgery `verify-state.py --audit` exists to catch (`builders.s1` stamped `orchestrator`, a
  `reviews.<slice>` stamped `builder`). The reason for the restraint is measured, not
  aesthetic: across this fleet 39 keys are stamped correctly, 31 carry no stamp, 13 carry
  the placeholder and **zero** are genuine mismatches, so a naive `value !== expected` rule
  paints 44 of 83 keys red and the signal becomes one nobody reads.

Auto-refresh (`scheduleAutoRefresh`) polls `/api/graph` every 4s only while at least one run
in the *current* payload has a status in `ACTIVE_STATUSES`, and cancels itself the moment
none do — it is not a fixed interval, it turns itself on and off with what is on disk.

## The one constraint that matters: what it depends on

**FleetView depends on a data format, not on a directory.** It never imports fleet code,
and the fleet location is runtime config: `--fleet`, else `$FLEETVIEW_FLEET`, else
auto-detection (`./graph_agents`, then `.`, then `../graph_agents`). A directory qualifies
as a fleet by *shape* — it contains `.graph/runs/` and/or `.claude/agents/`.

This is deliberate and load-bearing. Hardcoding a sibling path would make this app depend
on `graph_agents/`, which the umbrella constitution forbids. Keep it config.

If you extend the reader, the rule is: **a missing or malformed input renders as a visible
state, never as a crash.** No fleet found, no registry, an unparseable `state.json`, a run
directory with no `state.json` — each already has a defined rendering. Match that.

The format it reads (all optional, all guarded):

```
<fleet>/.graph/runs/<run-id>/state.json    run_id, goal, app, status, scout, architect,
                                           approved_by_human, scope_exceptions, builders,
                                           reviews, integrator, ops, log
                                           (each node key may carry written_by)
<fleet>/.claude/agents/*.md                frontmatter: name, description, tools, model
<fleet>/.claude/skills/*/SKILL.md          frontmatter: name, description
<fleet>/portfolio/registry.json            umbrella, updated, apps[]
<parent of fleet>/*/                       directory NAMES only, for Anonymize
```

That last one is the only read outside the fleet directory, and it is deliberately
shallow: `collect_siblings` lists the names of the directories beside the fleet root and
reads nothing inside them. Anonymize needs it because the registry does not name every
app — it shrank from 8 entries to 4, and the deregistered names are still all over the
runs that touched them. A name the page never learns is one it cannot redact.

`--fleet` is repeatable. `serve.py` resolves it into a `fleets` list of `{id, label, path,
found}` (id is the absolute path, and is what a request's `?fleet=` query value names) and
serves whichever one a request asks for, defaulting to the first. With zero or one `--fleet`
this degrades to exactly the original single-fleet behavior — do not let a multi-fleet
change alter what a single `--fleet` or auto-detect run does.

## Constraints

- **Read-only, permanently.** No route writes anything. If a run looks wrong in FleetView,
  the state is wrong — fix the state, not the view.
- **Binds `127.0.0.1` by default.** Nothing here is authenticated and the payload contains
  local filesystem paths. Do not bind it wider.
- **Stdlib and vanilla only.** No pip install, no npm, no CDN. A viewer that needs a build
  step to look at a JSON file has lost the plot.
- **A rejection is history, not a failure.** A slice stores attempt 1's `REJECT` at the top
  of `reviews.<slice>` and nests the re-review under `attempt_2`. Always resolve to the
  *final* attempt for the verdict, while still drawing the loop back to the builder.
  Reading `verdict` alone paints a fixed slice as failed.
- **Anonymize is a safety feature, not a preference.** A registry names real local
  directories, and so do a run id (`2026-09-01-huntstack-mobile`), a goal sentence, a
  changed-file path and a `state.json` path — all of them on the default screen. So the
  toggle does not relabel the `app` field; it redacts every identifier the payload knows
  out of **every string the page renders**, plus absolute paths (`/Users/<name>` →
  `<user>`) and email addresses. It is applied inside `el()`, the one choke point every
  render passes through, because "remember to anonymize this one too" is precisely the
  rule that failed. Do not scrub `data-*` attributes — node selection reads them back.
  Identifiers come from three sources, and all three are needed: registry app ids, each
  run's `app`, and `siblings`. Order matters inside `scrub()`: emails and home paths are
  taken out **before** app ids, or an id that is a substring of an address (`njcurtis3`
  inside `nathanjcurtis3@…`) shreds the address into a fragment the email pattern no
  longer matches, leaving half a real name on screen.
  **The limit, and state it rather than implying otherwise:** an app named only in prose
  that no source knows is not a token this can redact. Anonymize makes a screenshot safe
  to share; it is not a publication-grade redaction.
- **Node/node click selection never triggers a refetch.** Only a fleet switch, the Refresh
  button, and the 4s auto-refresh call `/api/graph`. If you add a feature that touches
  `selectedRun`/`selectedNode`, keep it reading from the already-loaded `DATA`.
- With more than one `--fleet`, switching fleets must reset `selectedRun`/`selectedNode` —
  a run id from one fleet is meaningless in another and must never silently carry over.

## Testing

```bash
node fleetview/test.js
```

`test.js` runs `index.html`'s own `<script>` inside a `vm` context with a hand-rolled
document/window/location/history/fetch shim, against small fixture payloads shaped like
real `/api/graph` responses — not a live server, not a browser, no dependencies beyond
Node's stdlib. It covers: the render pipeline against a realistic run (including a
REJECT-then-PASS slice, checked for the *final* verdict and the side-by-side diff view),
Anonymize leaking nothing anywhere, the no-fleet banner, the URL router (deep link on load,
node clicks `replaceState`, run/tab switches `pushState`, neither refetches), the fleet
switcher plus auto-refresh scheduling, and the conditional request (a 304 keeps `DATA`,
moves the stamp, raises no banner and keeps polling; a client holding no ETag still gets a
200 and renders; Refresh sends no `If-None-Match` while the silent poll still does). It also
covers the three state-provenance signals against fixtures taken from real runs: a
`scope_exceptions` array holding only the schema docstring renders zero exceptions, seven
real paths render seven, a `WHY (…)` rationale full of slashes counts for none, all four
`written_by` states render as they should — including a run with no stamp anywhere raising
no warning — and `_mtime` renders as a relative age without a fresh heartbeat being called
wedged. Every wedged-run fixture holds **both** clocks stale on purpose, so the status rule
is the only thing that can suppress the pill; an assertion resting on a fresh `_mtime` or on
a run with no `_activity` passes for the wrong reason and cannot catch a deleted guard.
The `fetch` shim models status and headers, not just a body, so the 304
path is exercised rather than assumed. Auto-refresh's real timer is deliberately never
allowed to fire in the harness (only recorded) — letting it fire for real would recurse into
an actual 4-second polling loop and hang the test process, since the fixture always reports
an active run.

Extend `test.js`, don't skip it, when you touch the router, the fleet switcher, or
auto-refresh — those are exactly the places a change silently breaks without a fast,
deterministic check. Render-only changes (new inspector fields, new CSS) don't need a new
test; a real fleet and a nonexistent one, by eye, is still how those get checked.
