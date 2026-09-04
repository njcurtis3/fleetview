#!/usr/bin/env python3
"""FleetView -- a local viewer for agent-fleet run state.

Serves index.html plus one JSON endpoint assembled live from a fleet directory
on disk. Stdlib only: no dependencies, no build step, no network access.

FleetView reads a *format*, not a particular sibling directory. Point it
anywhere:

    python fleetview/serve.py                    # auto-detect a fleet
    python fleetview/serve.py --fleet ../elsewhere/graph_agents
    python fleetview/serve.py --fleet ../a/graph_agents --fleet ../b/graph_agents

Repeat --fleet to register more than one; /api/graph then accepts a ?fleet=
query param (the id is the fleet path) and the page grows a fleet switcher
instead of a static path. With zero or one --fleet the app behaves exactly
as a single-fleet viewer always has.

A "fleet directory" is anything containing .graph/runs/ and/or .claude/agents/.
If none is found the app still starts and says so -- it is a viewer, and having
nothing to view is a legitimate state, not a crash.

Data is re-read from disk on every /api/graph request, so a run that is still
executing updates on refresh (or on its own, via the page's auto-refresh while
a run is active).
"""

import argparse
import json
import os
import sys
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

APP_DIR = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
# locating a fleet
# --------------------------------------------------------------------------

def looks_like_fleet(path):
    """A fleet is identified by its shape, not by its name."""
    if not path or not os.path.isdir(path):
        return False
    return (os.path.isdir(os.path.join(path, ".graph", "runs"))
            or os.path.isdir(os.path.join(path, ".claude", "agents")))


def _auto_detect():
    """Return (path_or_None, [places_searched]) with no explicit hint.

    Search order, most specific first:
      1. ./graph_agents  -- the umbrella layout, launched from repos/
      2. .               -- launched from inside a fleet directory
      3. ../graph_agents -- a sibling of this app, however you launched it
    """
    cwd = os.getcwd()
    candidates = [
        os.path.join(cwd, "graph_agents"),
        cwd,
        os.path.join(os.path.dirname(APP_DIR), "graph_agents"),
    ]

    seen, searched = set(), []
    for c in candidates:
        c = os.path.abspath(c)
        if c in seen:
            continue
        seen.add(c)
        searched.append(c)
        if looks_like_fleet(c):
            return c, searched
    return None, searched


def resolve_fleets(explicit_list, env_fleet):
    """Return (fleets, searched).

    fleets is a list of {id, label, path, found} dicts, in the order given
    (or detection order for auto-detect). id is the absolute path -- it is
    what a URL's ?fleet= query param names. An explicit miss is reported as
    found:false, never silently dropped or replaced by a guess.

    searched is only ever non-empty in the true zero-hint, nothing-found
    case -- it names the auto-detect candidates that were tried, for the
    "point me at one" banner.
    """
    source = explicit_list if explicit_list else ([env_fleet] if env_fleet else None)

    if source:
        fleets, seen = [], set()
        for raw in source:
            path = os.path.abspath(os.path.expanduser(raw))
            if path in seen:
                continue
            seen.add(path)
            fleets.append({
                "id": path,
                "label": os.path.basename(path.rstrip(os.sep)) or path,
                "path": path,
                "found": looks_like_fleet(path),
            })
        return fleets, []

    path, searched = _auto_detect()
    if path:
        return [{
            "id": path,
            "label": os.path.basename(path.rstrip(os.sep)) or path,
            "path": path,
            "found": True,
        }], []
    return [], searched


class Fleet(object):
    """Paths within one fleet directory. Every read is guarded; a fleet that
    is missing a piece renders as a fleet missing that piece."""

    def __init__(self, root):
        self.root = root
        self.runs_dir = os.path.join(root, ".graph", "runs") if root else None
        self.agents_dir = os.path.join(root, ".claude", "agents") if root else None
        self.skills_dir = os.path.join(root, ".claude", "skills") if root else None
        self.registry = os.path.join(root, "portfolio", "registry.json") if root else None


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------

def read_json(path):
    """Return (data, error). Tolerates a BOM; never raises."""
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            return json.load(fh), None
    except FileNotFoundError:
        return None, "not found"
    except ValueError as exc:  # JSONDecodeError and UnicodeDecodeError both
        return None, "unreadable: %s" % exc
    except OSError as exc:
        return None, "unreadable: %s" % exc


def parse_frontmatter(path):
    """Pull the YAML-ish frontmatter block off an agent definition.

    Only the flat `key: value` form these files actually use is supported --
    this is not a YAML parser and does not need to be.
    """
    meta = {}
    try:
        with open(path, "r", encoding="utf-8-sig") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return meta

    if not lines or lines[0].strip() != "---":
        return meta

    for line in lines[1:]:
        if line.strip() == "---":
            break
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()
    return meta


def collect_agents(fleet):
    agents = []
    if not fleet.agents_dir or not os.path.isdir(fleet.agents_dir):
        return agents

    for name in sorted(os.listdir(fleet.agents_dir)):
        if not name.endswith(".md"):
            continue
        meta = parse_frontmatter(os.path.join(fleet.agents_dir, name))
        tools = [t.strip() for t in meta.get("tools", "").split(",") if t.strip()]
        agents.append({
            "name": meta.get("name", name[:-3]),
            "description": meta.get("description", ""),
            "model": meta.get("model", "unspecified"),
            "tools": tools,
            "file": ".claude/agents/" + name,
        })
    return agents


def collect_skills(fleet):
    skills = []
    if not fleet.skills_dir or not os.path.isdir(fleet.skills_dir):
        return skills

    for name in sorted(os.listdir(fleet.skills_dir)):
        skill_md = os.path.join(fleet.skills_dir, name, "SKILL.md")
        if not os.path.isfile(skill_md):
            continue
        meta = parse_frontmatter(skill_md)
        skills.append({
            "name": meta.get("name", name),
            "description": meta.get("description", ""),
            "file": ".claude/skills/%s/SKILL.md" % name,
        })
    return skills


def collect_runs(fleet):
    """Every run directory, newest first. A broken state.json becomes a
    visible error row rather than a missing one -- showing what is actually on
    disk is the whole point of this app."""
    runs = []
    if not fleet.runs_dir or not os.path.isdir(fleet.runs_dir):
        return runs

    for name in sorted(os.listdir(fleet.runs_dir), reverse=True):
        run_dir = os.path.join(fleet.runs_dir, name)
        if not os.path.isdir(run_dir):
            continue

        state_path = os.path.join(run_dir, "state.json")
        state, error = read_json(state_path)
        rel = ".graph/runs/%s/state.json" % name

        if error is not None:
            runs.append({
                "run_id": name, "goal": "", "app": "", "status": "unreadable",
                "_error": "state.json %s" % error, "_path": rel,
            })
            continue

        state["_path"] = rel
        state["_mtime"] = datetime.fromtimestamp(
            os.path.getmtime(state_path), timezone.utc
        ).isoformat()
        state.setdefault("run_id", name)
        activity = collect_activity(run_dir)
        if activity is not None:
            state["_activity"] = activity
        runs.append(state)

    return runs


def collect_activity(run_dir):
    """A run's node heartbeat, if the fleet writes one.

    `activity.jsonl` is one JSON object per line, appended by the fleet's hooks as
    nodes start, call tools and stop. FleetView neither requires nor writes it: a
    fleet without one, or with an older run that predates it, simply has no lane.

    Returns a summary plus the tail, not the whole file. A long run produces
    thousands of lines and the viewer only ever shows recent activity -- shipping
    the lot on every 4s poll would make the payload the slowest thing here.
    """
    path = os.path.join(run_dir, "activity.jsonl")
    if not os.path.isfile(path):
        return None

    events, skipped = [], 0
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    skipped += 1          # a torn final line while a hook appends
                    continue
                if isinstance(event, dict):
                    events.append(event)
    except OSError as exc:
        return {"error": str(exc), "agents": [], "tail": []}

    agents = {}
    for event in events:
        name = str(event.get("agent") or "?")
        row = agents.setdefault(name, {"agent": name, "tools": 0, "spawns": 0,
                                       "first": None, "last": None, "open": 0})
        kind = event.get("ev")
        if kind == "tool":
            row["tools"] += 1
        elif kind == "start":
            row["spawns"] += 1
            row["open"] += 1
        elif kind == "stop":
            row["open"] = max(0, row["open"] - 1)
        stamp = event.get("t")
        if isinstance(stamp, (int, float)):
            row["first"] = stamp if row["first"] is None else min(row["first"], stamp)
            row["last"] = stamp if row["last"] is None else max(row["last"], stamp)

    return {
        "total": len(events),
        "skipped": skipped,
        "agents": sorted(agents.values(), key=lambda r: (r["first"] is None, r["first"])),
        "tail": events[-40:],
    }


def collect_siblings(fleet):
    """Directory names beside the fleet root.

    These are the local app directories, and the page needs them for one reason only:
    Anonymize. A run's prose names apps that the registry no longer lists -- it shrank
    from 8 entries to 4 -- and a name the page never learns is a name it cannot redact
    out of a screenshot. Names only, never paths, and never their contents.
    """
    if not fleet.root:
        return []
    parent = os.path.dirname(fleet.root.rstrip(os.sep))
    if not parent or not os.path.isdir(parent):
        return []
    try:
        return sorted(name for name in os.listdir(parent)
                      if not name.startswith(".") and os.path.isdir(os.path.join(parent, name)))
    except OSError:
        return []


def collect_portfolio(fleet):
    if not fleet.registry:
        return {"available": False, "reason": "no fleet directory", "apps": []}

    data, error = read_json(fleet.registry)
    if error is not None:
        # Routinely expected: a fleet may keep its registry untracked.
        return {"available": False, "reason": error, "apps": []}

    return {
        "available": True,
        "umbrella": data.get("umbrella", ""),
        "updated": data.get("updated", ""),
        "apps": data.get("apps", []),
    }


def build_payload(fleets, fleet_objs, searched, requested_id):
    """Assemble one fleet's data plus the roster of all configured fleets.

    requested_id selects which fleet is active for this request (a ?fleet=
    query value); an unknown or missing id falls back to fleets[0]. Every
    fleet in `fleets` -- found or not -- is echoed back so the page can
    render a switcher and mark the ones that are not on disk right now.
    """
    if fleets:
        active = next((f for f in fleets if f["id"] == requested_id), fleets[0])
        fleet = fleet_objs[active["id"]]
    else:
        active = {"id": "", "label": "", "path": "", "found": False}
        fleet = Fleet(None)

    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "fleet": {
            "found": active["found"],
            "path": active["path"],
            "searched": searched if not active["found"] and not fleets else [],
        },
        "fleets": [{"id": f["id"], "label": f["label"], "path": f["path"], "found": f["found"]}
                   for f in fleets],
        "active_fleet_id": active["id"],
        "portfolio": collect_portfolio(fleet),
        "siblings": collect_siblings(fleet),
        "agents": collect_agents(fleet),
        "skills": collect_skills(fleet),
        "runs": collect_runs(fleet),
    }


# --------------------------------------------------------------------------
# serving
# --------------------------------------------------------------------------

def make_handler(fleets, fleet_objs, searched):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, content_type):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path

            if path == "/api/graph":
                requested = parse_qs(parsed.query).get("fleet", [None])[0]
                try:
                    payload = json.dumps(build_payload(fleets, fleet_objs, searched, requested))
                except (TypeError, ValueError) as exc:
                    self._send(500, json.dumps({"error": str(exc)}), "application/json")
                    return
                self._send(200, payload, "application/json; charset=utf-8")
                return

            if path in ("/", "/index.html"):
                try:
                    with open(os.path.join(APP_DIR, "index.html"), "rb") as fh:
                        self._send(200, fh.read(), "text/html; charset=utf-8")
                except OSError:
                    self._send(500, "index.html is missing", "text/plain; charset=utf-8")
                return

            self._send(404, "not found", "text/plain; charset=utf-8")

        def log_message(self, fmt, *args):
            # One quiet line per request; the default handler is noisy.
            sys.stderr.write("  %s\n" % (fmt % args))

    return Handler


def main():
    parser = argparse.ArgumentParser(
        description="FleetView -- a local viewer for agent-fleet run state")
    parser.add_argument("--fleet", action="append", default=None,
                        help="fleet directory to read; repeat to register more than "
                             "one and get a fleet switcher (default: auto-detect; "
                             "env FLEETVIEW_FLEET)")
    parser.add_argument("--port", type=int, default=8787, help="default 8787")
    parser.add_argument("--host", default="127.0.0.1",
                        help="default 127.0.0.1 (local only; nothing here is authenticated)")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    fleets, searched = resolve_fleets(args.fleet, os.environ.get("FLEETVIEW_FLEET"))
    fleet_objs = {f["id"]: Fleet(f["path"] if f["found"] else None) for f in fleets}

    try:
        server = HTTPServer((args.host, args.port), make_handler(fleets, fleet_objs, searched))
    except OSError as exc:
        sys.stderr.write("FleetView: cannot bind %s:%d -- %s\n" % (args.host, args.port, exc))
        sys.stderr.write("Try: python fleetview/serve.py --port 8788\n")
        return 1

    url = "http://%s:%d/" % (args.host, args.port)
    sys.stderr.write("FleetView serving %s\n" % url)

    if fleets:
        for f in fleets:
            if f["found"]:
                fo = fleet_objs[f["id"]]
                sys.stderr.write("  fleet: %s (%d runs)\n" % (f["path"], len(collect_runs(fo))))
                if not collect_portfolio(fo)["available"]:
                    sys.stderr.write("    note: no readable portfolio/registry.json -- "
                                     "Portfolio tab will be empty for this fleet\n")
            else:
                sys.stderr.write("  fleet: %s -- NOT FOUND on disk\n" % f["path"])
        if len(fleets) > 1:
            sys.stderr.write("  %d fleets registered; use the switcher in the page header\n"
                             % len(fleets))
    else:
        # Not an error. A viewer with nothing to view still runs.
        sys.stderr.write("  fleet: NOT FOUND -- searched:\n")
        for path in searched:
            sys.stderr.write("           %s\n" % path)
        sys.stderr.write("  pass --fleet <path> to point it at one\n")

    sys.stderr.write("  ctrl-c to stop\n")

    if not args.no_open:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("\nFleetView stopped.\n")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
