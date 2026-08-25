# fleetview

FleetView is a local, read-only viewer for agent-fleet run state. It renders three things
from a fleet directory on disk: each run's work graph (drawn from that run's own
`state.json`), the node roster (read live from agent frontmatter), and the portfolio graph
(from the fleet's registry index). It is a viewer and nothing else — it never writes to a
run, and it has no opinion about one.

Standalone app under the repos/ umbrella. Never import from a sibling app; see ../graph_agents/CLAUDE.md.

## Run it

```bash
python fleetview/serve.py                      # auto-detect a fleet, open a browser
python fleetview/serve.py --fleet ../somewhere/graph_agents
python fleetview/serve.py --port 8788 --no-open
```

No dependencies, no build step, no install: Python 3 stdlib only, and the page loads no
external resources. There are no tests — see Constraints.

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
```

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
  directories. The toggle must hide app ids, one-liners, and stack tags everywhere they
  appear — the run list included, not just the Portfolio tab.
- No test suite. The app has no logic worth unit-testing and no dependencies to break; it
  is verified by pointing it at a real fleet and at a nonexistent one. If it grows real
  logic, that changes.
