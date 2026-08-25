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

1. `--fleet <path>`
2. `$FLEETVIEW_FLEET`
3. auto-detection: `./graph_agents`, then `.`, then `../graph_agents`

A directory qualifies by shape — it contains `.graph/runs/` and/or `.claude/agents/`. If
none is found the app still starts and tells you where it looked; a viewer with nothing to
view is a legitimate state, not a crash.

```bash
python fleetview/serve.py --fleet ../elsewhere/graph_agents
python fleetview/serve.py --port 8788 --no-open
```

## What it shows

**Runs** — each run's work graph, drawn from that run's own `state.json`. Node colour is
state, not decoration: green done or PASS, amber in flight or awaiting, red a REJECT or a
failure, grey never ran. The shape comes from `architect.shape`, so a `diamond` renders as
a real fan-out/fan-in and a `single-loop` renders as the sequential hand-off it is. A slice
that was rejected and then fixed draws the loop back to its builder *and* shows its final
verdict — a rejection is history, not a failure. Click any node to read exactly what it
appended to state: scout's facts, unknowns and risks; the architect's rationale and NOT
DOING list; a builder's changed files and gate results; a reviewer's findings, per attempt.

**Portfolio** — the static app graph from the fleet's registry index.

**Roster** — the agent nodes, read live from `.claude/agents/` frontmatter, with model tier
and tool grants. This is the definition the orchestrator actually spawns, not a copy of it
that can drift.

## Notes

- **It is a viewer.** No route writes anything. If a run looks wrong here, the state is
  wrong — fix the state.
- Disk is re-read on every request, so a run still executing updates on **Refresh**.
- **Anonymize** relabels apps as App 1..N and hides one-liners and stack tags, everywhere
  they appear. A registry names real local directories; use it before screenshotting.
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
