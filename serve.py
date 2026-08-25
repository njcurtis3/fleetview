#!/usr/bin/env python3
"""FleetView -- a local viewer for agent-fleet run state.

Serves index.html plus one JSON endpoint assembled live from a fleet directory
on disk. Stdlib only: no dependencies, no build step, no network access.

FleetView reads a *format*, not a particular sibling directory. Point it
anywhere:

    python fleetview/serve.py                    # auto-detect a fleet
    python fleetview/serve.py --fleet ../elsewhere/graph_agents

A "fleet directory" is anything containing .graph/runs/ and/or .claude/agents/.
If none is found the app still starts and says so -- it is a viewer, and having
nothing to view is a legitimate state, not a crash.

Data is re-read from disk on every /api/graph request, so a run that is still
executing updates on refresh.
"""

import argparse
import json
import os
import sys
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

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


def resolve_fleet(explicit):
    """Return (path_or_None, [places_searched]).

    Search order, most specific first:
      1. --fleet, if given (an explicit miss is reported, never silently
         replaced by a guess)
      2. ./graph_agents  -- the umbrella layout, launched from repos/
      3. .               -- launched from inside a fleet directory
      4. ../graph_agents -- a sibling of this app, however you launched it
    """
    if explicit:
        p = os.path.abspath(os.path.expanduser(explicit))
        return (p if looks_like_fleet(p) else None), [p]

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
        runs.append(state)

    return runs


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


def build_payload(fleet, searched):
    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "fleet": {
            "found": bool(fleet.root),
            "path": fleet.root or "",
            "searched": searched,
        },
        "portfolio": collect_portfolio(fleet),
        "agents": collect_agents(fleet),
        "skills": collect_skills(fleet),
        "runs": collect_runs(fleet),
    }


# --------------------------------------------------------------------------
# serving
# --------------------------------------------------------------------------

def make_handler(fleet, searched):
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
            path = self.path.split("?", 1)[0]

            if path == "/api/graph":
                try:
                    payload = json.dumps(build_payload(fleet, searched))
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
    parser.add_argument("--fleet", default=os.environ.get("FLEETVIEW_FLEET"),
                        help="fleet directory to read (default: auto-detect; "
                             "env FLEETVIEW_FLEET)")
    parser.add_argument("--port", type=int, default=8787, help="default 8787")
    parser.add_argument("--host", default="127.0.0.1",
                        help="default 127.0.0.1 (local only; nothing here is authenticated)")
    parser.add_argument("--no-open", action="store_true", help="do not open a browser")
    args = parser.parse_args()

    root, searched = resolve_fleet(args.fleet)
    fleet = Fleet(root)

    try:
        server = HTTPServer((args.host, args.port), make_handler(fleet, searched))
    except OSError as exc:
        sys.stderr.write("FleetView: cannot bind %s:%d -- %s\n" % (args.host, args.port, exc))
        sys.stderr.write("Try: python fleetview/serve.py --port 8788\n")
        return 1

    url = "http://%s:%d/" % (args.host, args.port)
    sys.stderr.write("FleetView serving %s\n" % url)

    if root:
        sys.stderr.write("  fleet: %s\n" % root)
        sys.stderr.write("  runs:  %d\n" % len(collect_runs(fleet)))
        if not collect_portfolio(fleet)["available"]:
            sys.stderr.write("  note:  no readable portfolio/registry.json -- "
                             "Portfolio tab will be empty\n")
    else:
        # Not an error. A viewer with nothing to view still runs.
        sys.stderr.write("  fleet: NOT FOUND -- searched:\n")
        for s in searched:
            sys.stderr.write("           %s\n" % s)
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
