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
                                           approved_by_human, builders, reviews,
                                           integrator, ops, log
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
node clicks `replaceState`, run/tab switches `pushState`, neither refetches), and the fleet
switcher plus auto-refresh scheduling. Auto-refresh's real timer is deliberately never
allowed to fire in the harness (only recorded) — letting it fire for real would recurse into
an actual 4-second polling loop and hang the test process, since the fixture always reports
an active run.

Extend `test.js`, don't skip it, when you touch the router, the fleet switcher, or
auto-refresh — those are exactly the places a change silently breaks without a fast,
deterministic check. Render-only changes (new inspector fields, new CSS) don't need a new
test; a real fleet and a nonexistent one, by eye, is still how those get checked.
