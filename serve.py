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

/api/graph also takes two additive query parameters, and neither one changes
what a request without them gets:

    /api/graph                    # the whole payload, every run in full
    /api/graph?runs=light         # every run, reduced to a flat row
    /api/graph?run=<run-id>       # that one run, in full, in an envelope

No parameter still returns the whole payload, and that default is the entire
compatibility story in both directions: an older page sends neither parameter
and gets the bytes it got yesterday, while a newer page against an older
server sees no runs_mode in the reply, falls back to the full runs[] and
renders correct-but-large.

They are not mutually exclusive, and the precedence is defined rather than
accidental, so nothing here has to be discovered by experiment:

    ?runs=light&run=<id>   run wins -- the detail envelope, runs= ignored,
                           because naming one run is the more specific ask
    ?run=a&run=b           the first value, as with every repeated parameter
    ?runs=<anything else>  the whole payload, with no runs_mode: an older
                           server ignores a value it does not know, and so
                           does this one
    ?run=<unknown id>      404 with a JSON body, including a bare ?run=

A "fleet directory" is anything containing .graph/runs/ and/or .claude/agents/.
If none is found the app still starts and says so -- it is a viewer, and having
nothing to view is a legitimate state, not a crash.

Data is re-read from disk on every /api/graph request, so a run that is still
executing updates on refresh (or on its own, via the page's auto-refresh while
a run is active).
"""

import argparse
import hashlib
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


def activity_last(activity):
    """The newest heartbeat stamp in a run's activity summary, or None.

    Defined as exactly what index.html's activityAgeSecs() computes -- the max over
    agents[].last AND tail[].t -- because a light row carries this one number instead
    of the summary and the wedged pill reads whichever of the two it has. Taking the
    agent rows alone looks right and is not: an event whose agent row never got a
    numeric stamp still stamps the tail, so the two clocks would drift and the same
    run would read wedged in the list and fine in the detail pane, with nothing thrown.

    None is the ordinary answer, not a fault: the lane is optional in both directions,
    and a summary that failed to read claims nothing.
    """
    if not isinstance(activity, dict) or activity.get("error"):
        return None

    stamps = [row.get("last") for row in activity.get("agents") or []
              if isinstance(row, dict)]
    stamps += [event.get("t") for event in activity.get("tail") or []
               if isinstance(event, dict)]

    newest = None
    for stamp in stamps:
        if isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
            newest = stamp if newest is None else max(newest, stamp)
    return newest


def count_rejected_slices(reviews):
    """How many slices were REJECTed at least once.

    Mirrors everRejected() in index.html: attempt 1 sits at the top of
    reviews.<slice> and the re-reviews nest under attempt_2, attempt_3, ..., so a
    slice that was rejected and then fixed still counts here. Reading `verdict` alone
    would report that slice as clean and lose the loop entirely.
    """
    if not isinstance(reviews, dict):
        return 0

    rejected = 0
    for review in reviews.values():
        if not isinstance(review, dict):
            continue
        attempts = [review]
        for i in range(2, 10):
            nxt = review.get("attempt_%d" % i)
            if not isinstance(nxt, dict):
                break
            attempts.append(nxt)
        if any(a.get("verdict") == "REJECT" for a in attempts):
            rejected += 1
    return rejected


def slice_ids(run):
    """Every slice id in a run, mirroring sliceIds() in index.html.

    A run's slices are the plan's truthy `slice` values UNION every key in
    `builders`, because a builder can be added off-plan -- an authorized extra pass
    the architect never named -- and an off-plan slice is a real slice. Counting the
    plan alone is wrong on 3 of this fleet's 10 runs.

    This exists so `_n_slices` on a light row is the number the detail header would
    have shown anyway. Ship the plan length instead and the header paints "5 slices"
    from the row and flips to "6" when the depth lands, which is exactly the pop the
    synchronous header exists to prevent.
    """
    architect = run.get("architect")
    plan = architect.get("plan") if isinstance(architect, dict) else None
    ids = []
    if isinstance(plan, list):
        for entry in plan:
            if isinstance(entry, dict) and entry.get("slice"):
                ids.append(entry["slice"])

    builders = run.get("builders")
    if isinstance(builders, dict):
        for key in builders:
            if key not in ids:
                ids.append(key)
    return ids


def light_row(run):
    """One run reduced to the flat fields the run LIST actually reads.

    Everything here is FLAT on purpose. The cheap move is to ship a stub
    `architect: {shape}` so renderRunList keeps working untouched, and it is the
    wrong one: a half-populated `architect` is indistinguishable from a real one, so
    `run.architect.plan` reads undefined and renders an EMPTY slice list where a
    loading state belongs. `_shape` cannot be mistaken for the real key, and `_light`
    is the marker any code can test to ask "is this the whole run?".

    `_activity_last` is the wedged pill's clock and `_activity_n` is
    collect_activity's event count. The count is what makes a client's cache
    invalidation exact rather than probabilistic: two events appended within the same
    float tick leave the timestamp unchanged while the tail moves, so invalidating on
    the timestamp alone would freeze a live run's activity lane indefinitely.

    Every field is emitted for every run, None where the run has nothing, so a row's
    shape never depends on which run it describes. `_error` is the one exception --
    present only on a run whose state.json would not read, exactly as in the full
    payload, because the page renders it on presence.
    """
    activity = run.get("_activity")
    if not isinstance(activity, dict):
        activity = {}
    architect = run.get("architect")
    if not isinstance(architect, dict):
        architect = {}

    row = {
        "run_id": run.get("run_id"),
        "goal": run.get("goal", ""),
        "app": run.get("app", ""),
        "status": run.get("status", ""),
        "approved_by_human": run.get("approved_by_human"),
        "_path": run.get("_path"),
        "_mtime": run.get("_mtime"),
        "_activity_last": activity_last(activity),
        "_activity_n": activity.get("total"),
        "_shape": architect.get("shape") or "",
        "_n_slices": len(slice_ids(run)),
        "_n_rejects": count_rejected_slices(run.get("reviews")),
        "_light": True,
    }
    if run.get("_error"):
        row["_error"] = run["_error"]
    return row


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


def active_fleet(fleets, fleet_objs, requested_id):
    """Return (the active fleet's dict, its Fleet reader) for one request.

    requested_id is a ?fleet= query value; an unknown or missing id falls back to
    fleets[0]. Every response shape resolves it through here, so a run detail and
    the list it was clicked from can never disagree about which fleet they are in.
    """
    if fleets:
        active = next((f for f in fleets if f["id"] == requested_id), fleets[0])
        return active, fleet_objs[active["id"]]
    return {"id": "", "label": "", "path": "", "found": False}, Fleet(None)


def build_payload(fleets, fleet_objs, searched, requested_id):
    """Assemble one fleet's data plus the roster of all configured fleets.

    This is the answer to a request that asked for nothing in particular, and it is
    unchanged: every run in full. Every fleet in `fleets` -- found or not -- is
    echoed back so the page can render a switcher and mark the ones that are not on
    disk right now.
    """
    active, fleet = active_fleet(fleets, fleet_objs, requested_id)

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


def build_light(payload):
    """The full payload with runs[] reduced to flat rows, in place.

    Derived from the assembled payload rather than read separately, so a light row
    can only ever hold a value the full response would have shipped for that same
    run: one read, one shape, and no second definition of _activity_last to drift
    from the one the detail pane recomputes.

    EVERY run stays in the list. The split is by DEPTH, not by count -- dropping runs
    would break anyRunActive (auto-refresh dies on a background run), buildAnonMap (a
    real app name silently un-redacted as "App ?", a safety feature failing quietly),
    the filter, and every deep link into history.

    runs_mode is the whole negotiation and there is no other version marker: a page
    that sees it knows this server splits, and a page that does not falls back to the
    full runs[] an older server just gave it.
    """
    payload["runs"] = [light_row(run) for run in payload.get("runs") or []]
    payload["runs_mode"] = "light"
    return payload


def build_detail(fleets, fleet_objs, requested_id, run_id):
    """One run in full, in an envelope. None when this fleet has no such run.

    THE RUN ID NAMES A DIRECTORY AND IS NEVER JOINED ONTO ONE. It is resolved by
    equality against the run_id of the runs collect_runs() already listed, so
    ?run=../../../etc/passwd matches nothing and 404s having read no path the query
    named. This server ships local filesystem paths in its payload and binds
    127.0.0.1 for that reason; building a path out of a query string is the one move
    that would stop being enough.

    Matching the listed run_id rather than the directory name also means the id the
    page asks with is the id the page was shown, and the run it gets back is the same
    object the full payload holds for it, key for key.

    active_fleet_id and run_id sit INSIDE the envelope, not in the URL alone, because
    the envelope is what the ETag hashes and a bare run object names neither. Two
    fleets can hold a run directory with the same id and a byte-identical state.json
    -- a copied run -- so hashing the run alone would let one fleet's token match
    another fleet's body: a false 304, which is a live view frozen forever.

    It holds no state either. The run is re-read from disk on every request, like
    every other response here.
    """
    active, fleet = active_fleet(fleets, fleet_objs, requested_id)
    run = next((r for r in collect_runs(fleet) if r.get("run_id") == run_id), None)
    if run is None:
        return None

    return {
        "generated": datetime.now(timezone.utc).isoformat(),
        "active_fleet_id": active["id"],
        "runs_mode": "detail",
        "run_id": run_id,
        "run": run,
    }


# --------------------------------------------------------------------------
# serving
# --------------------------------------------------------------------------

def payload_etag(stable_body):
    """A strong ETag for one /api/graph response.

    Hashed over the response's content with `generated` removed -- that field is
    stamped per request and would otherwise make every ETag unique and the
    conditional request pointless. NOT a hash of the bytes that ship: the caller
    pops `generated`, serializes and hashes the remainder, then puts `generated`
    back before serializing the body, so it lands last in the shipped JSON and the
    hashed string is not a substring of it. Only the content is shared, which is
    all the ETag claims. Same hash iff same content, so a *false* 304 -- a live
    view frozen forever -- cannot happen by construction, which an mtime-derived
    token could not promise at sub-second write granularity.

    This holds no server state: it is recomputed from disk on every request and the
    client keeps the only copy.
    """
    return '"%s"' % hashlib.sha256(stable_body.encode("utf-8")).hexdigest()


def etag_matches(header_value, etag):
    """True when a request's If-None-Match names the ETag we just computed.

    Tolerant of the comma list, of the weak prefix and of `*`, per RFC 7232 -- a
    header we cannot parse simply misses and ships the body, which is the safe way
    to be wrong here.
    """
    if not header_value:
        return False
    for candidate in header_value.split(","):
        candidate = candidate.strip()
        if candidate.startswith("W/"):
            candidate = candidate[2:]
        if candidate == "*" or candidate == etag:
            return True
    return False


def make_handler(fleets, fleet_objs, searched):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body, content_type, etag=None):
            if isinstance(body, str):
                body = body.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if etag:
                self.send_header("ETag", etag)
            self.end_headers()
            self.wfile.write(body)

        def _send_not_modified(self, etag):
            """304 with no body at all: the client's copy is still current.

            The ETag is repeated so the client can keep polling with it, and
            Cache-Control stays no-store -- the page revalidates by sending
            If-None-Match itself rather than by letting the browser cache decide,
            so the two headers do not fight.
            """
            self.send_response(304)
            self.send_header("Cache-Control", "no-store")
            self.send_header("ETag", etag)
            self.end_headers()

        def do_GET(self):
            parsed = urlparse(self.path)
            path = parsed.path

            if path == "/api/graph":
                # keep_blank_values so a bare `?run=` is seen as an empty id and 404s
                # like any other id that is not in the listing, instead of reading as
                # "no parameter at all" and quietly shipping the whole payload to a
                # page that asked for one run.
                query = parse_qs(parsed.query, keep_blank_values=True)
                requested = query.get("fleet", [None])[0]
                runs_mode = query.get("runs", [None])[0]
                wanted_run = query.get("run", [None])[0]

                try:
                    if wanted_run is not None:
                        payload = build_detail(fleets, fleet_objs, requested, wanted_run)
                        if payload is None:
                            # A JSON body, not the text/plain 404 below, so the page
                            # can render a stated "not in this fleet" pane rather than
                            # special-case a wall of text. An unknown id and a
                            # traversal attempt both land here, having matched no
                            # listed run.
                            self._send(404, json.dumps({
                                "error": "no such run in this fleet",
                                "run_id": wanted_run,
                            }), "application/json; charset=utf-8")
                            return
                    else:
                        payload = build_payload(fleets, fleet_objs, searched, requested)
                        # Only the value we know. An unrecognised ?runs= is ignored
                        # exactly as an older server ignores it: the reply carries no
                        # runs_mode, and a page reads that absence as "this server
                        # does not split" and renders the full runs[] it just got.
                        if runs_mode == "light":
                            payload = build_light(payload)
                    generated = payload.pop("generated", "")
                    stable = json.dumps(payload)
                except (TypeError, ValueError) as exc:
                    self._send(500, json.dumps({"error": str(exc)}), "application/json")
                    return

                # What the request asked for is inside the hashed content, and it has
                # to be re-earned for each shape rather than assumed: the fleet
                # (fleet, fleets, active_fleet_id) on the full and light responses,
                # and active_fleet_id plus run_id on the detail envelope. runs_mode is
                # in there too, so a light token can never match a full one and a
                # detail token can never 304 a list request. Every collision ruled out
                # here is a false 304 -- a live view frozen forever -- and none of them
                # is reachable by a single-fleet, single-mode request.
                etag = payload_etag(stable)
                if etag_matches(self.headers.get("If-None-Match"), etag):
                    self._send_not_modified(etag)
                    return

                payload["generated"] = generated
                try:
                    body = json.dumps(payload)
                except (TypeError, ValueError) as exc:
                    self._send(500, json.dumps({"error": str(exc)}), "application/json")
                    return
                self._send(200, body, "application/json; charset=utf-8", etag=etag)
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
