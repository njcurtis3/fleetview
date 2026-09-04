# FleetView

A local, read-only viewer for agent-fleet run state — the work graph of every run, the
node roster, and the portfolio graph, rendered from what the agents actually wrote to disk.

```bash
python fleetview/serve.py
```

Opens `http://127.0.0.1:8787/`. Python 3 stdlib only: no dependencies, no build step, no
install, no network access.

## Pointing it at a fleet

FleetView reads a **format**, not a fixed location. It resolves the fleet directory in this
order:

1. `--fleet <path>` (repeatable — see Multiple fleets below)
2. `$FLEETVIEW_FLEET`
3. auto-detection: `./graph_agents`, then `.`, then `../graph_agents`

A directory qualifies by shape — it contains `.graph/runs/` and/or `.claude/agents/`. If
none is found the app still starts and tells you where it looked; a viewer with nothing to
view is a legitimate state, not a crash.

```bash
python fleetview/serve.py --fleet ../elsewhere/graph_agents
python fleetview/serve.py --port 8788 --no-open
```

### Multiple fleets

Pass `--fleet` more than once to register several fleets at once:

```bash
python fleetview/serve.py --fleet ../a/graph_agents --fleet ../b/graph_agents
```

The header grows a fleet switcher in place of the static path. Switching fleets re-fetches
`/api/graph?fleet=<id>` (the id is the fleet's path) without a page reload, and resets the
selected run since run ids from one fleet mean nothing in another. With zero or one
`--fleet` the app behaves exactly as a single-fleet viewer always has.

## What it shows

**Runs** — each run's work graph, drawn from that run's own `state.json`. Node colour is
state, not decoration: green done or PASS, amber in flight or awaiting, red a REJECT or a
failure, grey never ran. The shape comes from `architect.shape`, so a `diamond` renders as
a real fan-out/fan-in and a `single-loop` renders as the sequential hand-off it is. A slice
that was rejected and then fixed draws the loop back to its builder *and* shows its final
verdict — a rejection is history, not a failure; when a slice went through more than one
review attempt, its findings render **side by side** instead of stacked, so you can compare
what changed between attempts at a glance. Click any node to read exactly what it appended
to state: scout's facts, unknowns and risks; the architect's rationale and NOT DOING list;
a builder's changed files and gate results; a reviewer's findings, per attempt.

Above the run list, a **search box** filters by run id, goal text, app, or status. While any
run is in an active status (scouting through integrating), a pulsing indicator appears in
the header and the page **auto-refreshes every 4 seconds** — no more clicking Refresh to
watch a run progress. It stops polling on its own once nothing is active.

**Portfolio** — the static app graph from the fleet's registry index.

**Roster** — the agent nodes, read live from `.claude/agents/` frontmatter, with model tier
and tool grants. This is the definition the orchestrator actually spawns, not a copy of it
that can drift.

## Sharing a view

Selecting a run, a node, or a tab updates the URL fragment (`#runs?run=<id>&node=<id>`,
`#portfolio`, `#roster`) — copy the address bar to hand someone the exact same view, reload
without losing your place, and use the browser's back button to step back through runs and
tabs. Node selection updates the URL without adding a history entry (so clicking through a
graph doesn't flood your back button); switching runs or tabs does add one.

## Notes

- **It is a viewer.** No route writes anything. If a run looks wrong here, the state is
  wrong — fix the state.
- Disk is re-read on every request, so a run still executing updates on **Refresh**, or on
  its own while it's active (see auto-refresh, above).
- **Anonymize** redacts app names as App 1..N wherever they appear — not just the `app`
  field, but inside run ids, goals, file paths and pasted command output — along with
  absolute home paths (`/Users/<name>` → `<user>`) and email addresses. Use it before
  screenshotting. It knows an app from the registry, from a run's `app`, or from a
  directory beside the fleet; an app named only in prose that matches none of those can
  still slip through, so it makes a screenshot safe to share rather than
  publication-grade.
- Binds `127.0.0.1` by default. Nothing here is authenticated — don't bind it wider.
- A run directory with an unparseable `state.json` shows as a visible error row rather than
  silently vanishing. Showing what is actually on disk is the whole point.

## Layout

```
fleetview/
  serve.py      http.server: / and /api/graph, assembled from disk per request
  index.html    self-contained page — vanilla JS, no framework, no CDN
  CLAUDE.md     architecture, constraints, and the format it reads
```
