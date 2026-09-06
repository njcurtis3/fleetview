#!/usr/bin/env node
// FleetView's own test suite. Runs index.html's script inside a small DOM
// shim (Node's vm module + hand-rolled document/window/location/history
// mocks) against synthetic fixture payloads shaped like real /api/graph
// responses -- so "it renders" and "the router works" are checked, not
// assumed. No dependencies: Node stdlib only, matching the app itself.
//
//   node fleetview/test.js
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = (() => {
  const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
  const m = /<script>([\s\S]*)<\/script>/.exec(html);
  if (!m) throw new Error("could not find <script> block in index.html");
  return m[1];
})();

let failures = 0;
let assertions = 0;

function ok(cond, msg) {
  assertions++;
  if (!cond) { failures++; console.log("  FAIL: " + msg); }
}

// ---------------------------------------------------------------------
// fixtures: shaped like real /api/graph payloads, kept small on purpose
// ---------------------------------------------------------------------

function baseFixture() {
  return {
    generated: new Date().toISOString(),
    fleet: { found: true, path: "C:\\fleets\\a", searched: [] },
    fleets: [{ id: "C:\\fleets\\a", label: "a", path: "C:\\fleets\\a", found: true }],
    active_fleet_id: "C:\\fleets\\a",
    portfolio: {
      available: true, umbrella: "repos", updated: "2026-01-01",
      apps: [
        { id: "realname-app", path: "realname-app", kind: "product", status: "active",
          one_liner: "a real product", stack: ["python"], entry_docs: [], owns: [] },
        { id: "fleetview", path: "fleetview", kind: "tool", status: "active",
          one_liner: "this app", stack: ["python", "html"], entry_docs: [], owns: [] }
      ]
    },
    agents: [
      { name: "scout", description: "recon", model: "haiku", tools: ["Read", "Grep"], file: ".claude/agents/scout.md" },
      { name: "architect", description: "plans", model: "opus", tools: ["Read"], file: ".claude/agents/architect.md" }
    ],
    skills: [{ name: "feature-graph", description: "run the graph", file: ".claude/skills/feature-graph/SKILL.md" }],
    runs: [
      {
        run_id: "run-done", goal: "ship the thing", app: "realname-app", status: "done",
        scout: { facts: ["fact one"], unknowns: [], risks: [] },
        architect: {
          shape: "single-loop", parallel_safe: false, rationale: "small change",
          plan: [{ slice: "s1", intent: "do it", files: ["a.py"], done_when: "tests pass" }],
          edges: "n/a", not_doing: ["a rewrite"]
        },
        approved_by_human: true,
        builders: { s1: { status: "done", branch: "master", changed: ["a.py"], notes: "" } },
        reviews: {
          s1: {
            verdict: "REJECT", attempt: 1, summary: "first pass had a bug",
            findings: [{ file: "a.py", line: 12, issue: "off by one", severity: "high" }],
            attempt_2: {
              verdict: "PASS", attempt: 2, summary: "fixed", findings: []
            }
          }
        },
        integrator: { merged: [], conflicts: [], verification: "" },
        ops: { gated: true, actions: [] },
        log: ["orchestrator: run opened", "scout: 1 fact"]
      },
      {
        run_id: "run-parked", goal: "a parked run", app: "realname-app", status: "parked",
        scout: { facts: [], unknowns: [], risks: [] },
        architect: { shape: "single-loop", parallel_safe: false, rationale: "", plan: [], edges: "", not_doing: [] },
        approved_by_human: false, builders: {}, reviews: {},
        integrator: { merged: [], conflicts: [], verification: "" },
        ops: { gated: true, actions: [] }, log: []
      }
    ]
  };
}

// One run reduced to the flat row `?runs=light` ships, mirroring serve.py's light_row.
// Flat on purpose: a stub `architect:{shape}` would be indistinguishable from a real
// one, so the page could not tell a loading run from an empty one.
function toLightRow(run) {
  const act = (run._activity && typeof run._activity === "object") ? run._activity : {};
  let last = null;
  const keep = (v) => { if (typeof v === "number" && (last === null || v > last)) last = v; };
  (act.agents || []).forEach((a) => keep(a.last));
  (act.tail || []).forEach((e) => keep(e.t));

  const plan = (run.architect && run.architect.plan) || [];
  const ids = plan.map((p) => p.slice).filter(Boolean);
  Object.keys(run.builders || {}).forEach((k) => { if (ids.indexOf(k) === -1) ids.push(k); });

  let rejects = 0;
  Object.keys(run.reviews || {}).forEach((k) => {
    const rv = run.reviews[k] || {};
    const attempts = [rv].concat([2, 3, 4, 5].map((i) => rv["attempt_" + i]).filter(Boolean));
    if (attempts.some((a) => a && a.verdict === "REJECT")) rejects++;
  });

  const row = {
    run_id: run.run_id, goal: run.goal || "", app: run.app || "", status: run.status || "",
    approved_by_human: run.approved_by_human,
    _path: run._path === undefined ? null : run._path,
    _mtime: run._mtime === undefined ? null : run._mtime,
    _activity_last: last,
    _activity_n: act.total === undefined ? null : act.total,
    _shape: (run.architect && run.architect.shape) || "",
    _n_slices: ids.length,
    _n_rejects: rejects,
    _light: true
  };
  if (run._error) row._error = run._error;
  return row;
}

// A full fixture split the way the server splits it: the light list one URL answers
// with, and the per-run detail the other one does.
function splitFixture(fx) {
  const details = {};
  fx.runs.forEach((r) => { details[r.run_id] = JSON.parse(JSON.stringify(r)); });
  const list = Object.assign({}, fx, { runs: fx.runs.map(toLightRow), runs_mode: "light" });
  return { list, details };
}

function detailFetches(sb) { return sb.fetchLog.filter((u) => /[?&]run=/.test(u)); }
function listFetches(sb) { return sb.fetchLog.filter((u) => /[?&]runs=/.test(u)); }

function noFleetFixture() {
  return {
    generated: new Date().toISOString(),
    fleet: { found: false, path: "", searched: ["C:\\a\\graph_agents", "C:\\a", "C:\\graph_agents"] },
    fleets: [], active_fleet_id: "",
    portfolio: { available: false, reason: "no fleet directory", apps: [] },
    agents: [], skills: [], runs: []
  };
}

// ---------------------------------------------------------------------
// sandbox: one vm context per test, its own document/window/location
// ---------------------------------------------------------------------

function makeSandbox(initialPayload, opts) {
  opts = opts || {};
  const roots = {};
  const historyLog = [];
  const fetchLog = [];
  const fetchHeaders = [];
  const timerLog = [];
  const pollFns = [];
  let payload = initialPayload;
  let fetchFails = false;
  let etag = opts.etag || null;             // null models a server that sends no ETag at all
  // The other half of the split: /api/graph?run=<id> answers from `details`, with its
  // OWN ETag. Two URLs, two bodies, two tokens -- a page that keeps one ETag for the
  // whole app sends the wrong one back and gets a false 304.
  let details = opts.details || null;       // null models a server that only ever sends full runs
  let detailEtag = opts.detailEtag || null;
  let detailMode = "ok";                    // "ok" | "404" | "reject"

  function mkEl(tag) {
    const children = [], attrs = {};
    const e = {
      tagName: tag, className: "", style: {}, dataset: {}, _children: children, _attrs: attrs, _opts: [],
      set innerHTML(v) { children.length = 0; e._opts.length = 0; }, get innerHTML() { return ""; },
      set textContent(v) { e._text = String(v); }, get textContent() { return e._text || ""; },
      get firstChild() { return children[0] || null; },
      appendChild(c) {
        if (c === null || c === undefined) throw new Error("appendChild(null) on <" + tag + ">");
        children.push(c);
        if (tag === "select" && c.tagName === "option") e._opts.push(c);
        return c;
      },
      removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
      setAttribute(k, v) { attrs[k] = String(v); if (k.indexOf("data-") === 0) e.dataset[k.slice(5)] = String(v); },
      getAttribute(k) { return k in attrs ? attrs[k] : null; },
      addEventListener(ev, fn) { (e._h || (e._h = {}))[ev] = fn; },
      closest(sel) {
        if (sel === ".tab" && ((e._attrs["class"] || e.className || "").indexOf("tab") !== -1)) return e;
        return null;
      },
      classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 40, right: 200, bottom: 40 }; },
      querySelector(sel) {
        const m = /^\[data-node="(.*)"\]$/.exec(sel);
        if (!m) return null;
        const want = m[1].split("\\").join("");
        (function walk(n) { return n; })(e); // no-op, keeps lint happy
        function walk2(n) {
          if (n._attrs && n._attrs["data-node"] === want) return n;
          for (const c of (n._children || [])) { const r = walk2(c); if (r) return r; }
          return null;
        }
        return walk2(e);
      },
      querySelectorAll() { return []; }
    };
    return e;
  }

  const documentMock = {
    createElement: mkEl,
    createElementNS: (ns, tag) => mkEl(tag),
    getElementById(id) { return roots[id] || (roots[id] = mkEl(id === "fleetselect" ? "select" : "div")); },
    querySelectorAll() { return []; },
    addEventListener() {}
  };

  const windowMock = { addEventListener(ev, fn) { (windowMock._h || (windowMock._h = {}))[ev] = fn; } };

  const locationMock = { hash: opts.initialHash || "" };
  const historyMock = {
    pushState(_, __, h) { historyLog.push(["push", h]); locationMock.hash = h.replace(/^#/, ""); },
    replaceState(_, __, h) { historyLog.push(["replace", h]); locationMock.hash = h.replace(/^#/, ""); }
  };

  const context = vm.createContext({
    document: documentMock,
    window: windowMock,
    location: locationMock,
    history: historyMock,
    CSS: { escape: (s) => String(s) },
    localStorage: {
      getItem: () => (opts.anon ? "1" : null),
      setItem() {}
    },
    // Models the transport, not just the body: /api/graph is a conditional request, so
    // a request whose If-None-Match matches the server's current ETag comes back 304
    // with no body at all. With no etag set this degrades to the old shim -- always
    // 200, no ETag header -- which is exactly an old server talking to a new page.
    fetch: (url, init) => {
      fetchLog.push(url);
      const sent = (init && init.headers) || {};
      fetchHeaders.push(sent);
      if (fetchFails) return Promise.reject(new Error("connection refused"));

      const wantsRun = /[?&]run=([^&]*)/.exec(String(url));
      if (wantsRun) {
        const id = decodeURIComponent(wantsRun[1]);
        const detailHeaders = { get: (n) => (String(n).toLowerCase() === "etag" ? detailEtag : null) };
        if (detailMode === "reject") return Promise.reject(new Error("detail connection refused"));
        const run = details && details[id];
        if (detailMode === "404" || !run) {
          return Promise.resolve({
            status: 404, ok: false, headers: detailHeaders,
            json: () => Promise.resolve({ error: "no such run in this fleet", run_id: id })
          });
        }
        if (detailEtag && sent["If-None-Match"] === detailEtag) {
          return Promise.resolve({
            status: 304, ok: false, headers: detailHeaders,
            json: () => Promise.reject(new Error("a 304 has no body to parse"))
          });
        }
        return Promise.resolve({
          status: 200, ok: true, headers: detailHeaders,
          json: () => Promise.resolve({
            generated: new Date().toISOString(),
            active_fleet_id: payload.active_fleet_id,
            runs_mode: "detail", run_id: id, run: run
          })
        });
      }

      const mkHeaders = () => ({ get: (n) => (String(n).toLowerCase() === "etag" ? etag : null) });
      if (etag && sent["If-None-Match"] === etag) {
        return Promise.resolve({
          status: 304, ok: false, headers: mkHeaders(),
          json: () => Promise.reject(new Error("a 304 has no body to parse"))
        });
      }
      return Promise.resolve({
        status: 200, ok: true, headers: mkHeaders(),
        json: () => Promise.resolve(payload)
      });
    },
    setTimeout: (fn, ms) => {
      timerLog.push(ms);
      // The 4s poll is captured, never allowed to fire on its own -- letting it run
      // would recurse into a real polling loop and hang the suite. A test that wants
      // one poll calls firePoll(), which runs the captured callback exactly once.
      if (ms >= 1000) { pollFns.push(fn); return { __fakeTimer: true }; }
      return setTimeout(fn, ms);
    },
    clearTimeout: () => {},
    console: console,
    Promise: Promise,
    Date: Date,
    JSON: JSON,
    Object: Object,
    Array: Array,
    RegExp: RegExp,
    Set: Set,
    Map: Map,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
    requestAnimationFrame: (cb) => { try { cb(); } catch (e) { throw e; } }
  });

  vm.runInContext(SCRIPT, context, { filename: "index.html<script>" });

  return {
    context, roots, historyLog, fetchLog, fetchHeaders, timerLog,
    setPayload(p) { payload = p; },
    setEtag(v) { etag = v; },
    setDetails(d) { details = d; },
    setDetailEtag(v) { detailEtag = v; },
    setDetailMode(v) { detailMode = v; },
    setFetchFails(v) { fetchFails = v; },
    firePoll() {
      const fn = pollFns.pop();
      if (!fn) throw new Error("no auto-refresh poll was scheduled to fire");
      pollFns.length = 0;
      fn();
    },
    all(n) { const o = []; (function w(x) { o.push(x); (x._children || []).forEach(w); })(n); return o; },
  };
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------

async function testRenderRegression() {
  console.log("render regression (single fleet, real-shaped fixture)");
  const sb = makeSandbox(baseFixture());
  await wait(50);

  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  ok(cards.length === 2, "expected 2 run cards, got " + cards.length);

  cards[0]._h.click();
  const nodes = sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"] && n._h && n._h.click);
  ok(nodes.length === 7, "expected 7 graph nodes for a single-loop 1-slice run (scout/architect/gate/builder/reviewer/integrator/ops), got " + nodes.length);

  nodes.forEach((n) => n._h.click());   // select every node kind, then deselect
  nodes.forEach((n) => n._h.click());

  ok(sb.fetchLog.length === 1, "initial load should fetch exactly once, got " + sb.fetchLog.length);
}

async function testRejectThenPassRendersFinalVerdict() {
  console.log("a REJECT-then-PASS slice shows the final verdict, not the rejection");
  const sb = makeSandbox(baseFixture());
  await wait(50);

  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  cards[0]._h.click();   // run-done, whose only slice was rejected then passed

  const reviewerNode = sb.all(sb.roots.rundetail).find(
    (n) => n._attrs["data-node"] === "reviewer:s1" && n._h && n._h.click
  );
  ok(!!reviewerNode, "reviewer:s1 node should exist");
  const reviewerNodeTexts = sb.all(reviewerNode).map((n) => n._text).filter(Boolean);
  ok(reviewerNodeTexts.some((t) => t === "PASS · try 2"),
    "reviewer node subtitle should reflect the final PASS (try 2), not the original REJECT -- got " + JSON.stringify(reviewerNodeTexts));

  reviewerNode._h.click();
  const texts = sb.all(sb.roots.rundetail).map((n) => n._text).filter(Boolean);
  ok(texts.some((t) => /side by side/.test(t)), "multi-attempt reviewer should render the side-by-side diff view");
  ok(texts.indexOf("attempt 1") !== -1 && texts.indexOf("attempt 2") !== -1,
    "diff view should label both attempt columns -- got " + JSON.stringify(texts.filter((t) => /^attempt /.test(t))));
}

async function testAnonymizeLeaksNothing() {
  console.log("anonymize hides real app ids everywhere they appear");
  const sb = makeSandbox(baseFixture(), { anon: true });
  await wait(50);

  const portfolioTexts = sb.all(sb.roots["view-portfolio"]).map((n) => n._text).filter(Boolean);
  const runlistTexts = sb.all(sb.roots.runlist).map((n) => n._text).filter(Boolean);
  ok(portfolioTexts.indexOf("realname-app") === -1, "real app id leaked into Portfolio tab");
  ok(runlistTexts.indexOf("realname-app") === -1, "real app id leaked into run list");
}

// Anonymize used to relabel the `app` field and nothing else, so the Portfolio tab said
// "App 1" while the run list beside it read `2026-09-01-huntstack-mobile` and the goal
// sentence named the app outright. Everything on the default screen is checked here,
// including the local account name in an absolute path.
function identityLeakFixture() {
  const fx = baseFixture();
  const r = fx.runs[0];
  r.run_id = "2026-09-01-realname-app-mobile";
  r.goal = "ship the realname-app mobile build";
  r._path = ".graph/runs/2026-09-01-realname-app-mobile/state.json";
  r.scout.facts = ["realname-app/src/api.ts:1 uses a Vite-only import"];
  r.architect.plan[0].files = ["realname-app/src/api.ts"];
  r.builders.s1.changed = ["realname-app/src/api.ts"];
  r.builders.s1.gate_results = "ran in C:\\Users\\natha\\Desktop\\repos\\realname-app -- exit 0";
  r.reviews.s1.summary = "re-ran realname-app's suite";
  r.log = ["orchestrator: opened against realname-app"];
  fx.fleet.path = "C:\\Users\\localdev\\Desktop\\repos\\graph_agents";
  fx.fleets[0].path = fx.fleet.path;

  // An app the registry no longer lists and no run's `app` field names -- it exists only
  // as a directory beside the fleet, and in prose. The registry shrank from 8 to 4, so
  // this is the common case, not a corner one.
  fx.siblings = ["graph_agents", "realname-app", "deregistered-tool", "brandname-site"];
  r.architect.rationale = "deregistered-tool does the same thing; brandname owns the domain";
  // a path with its backslashes doubled, as one arrives inside JSON prose
  r.integrator.verification = "ran in C:\\\\Users\\\\localdev\\\\repos and mailed dev@example.com";
  return fx;
}

function visibleText(sb) {
  const roots = ["runlist", "rundetail", "view-portfolio", "view-roster"];
  let out = roots.map((id) => sb.all(sb.roots[id]).map((n) => n.textContent || "").join(" ")).join(" ");
  out += " " + (sb.roots.fleetpath.textContent || "");
  return out;
}

async function testAnonymizeHidesRunIdsGoalsAndPaths() {
  console.log("anonymize hides run ids, goals, file paths and the local account name");

  // control: with the toggle OFF the real names must still be there, or the test
  // would pass just as well against a page that renders nothing.
  const off = makeSandbox(identityLeakFixture());
  await wait(50);
  const offNode = off.roots.rundetail.querySelector('[data-node="builder:s1"]');
  if (offNode) offNode._h.click();
  const offText = visibleText(off);
  ok(offText.indexOf("realname-app") !== -1, "control: real app id should be visible with anonymize off");
  ok(offText.indexOf("localdev") !== -1, "control: real account name should be visible with anonymize off");

  const sb = makeSandbox(identityLeakFixture(), { anon: true });
  await wait(50);

  // inspect every node of the run, not just one: a leak in the integrator's verification
  // is a leak, and it is one click away from the default screen.
  const nodes = sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"] && n._h && n._h.click);
  ok(nodes.length > 0, "expected inspectable nodes");
  let text = visibleText(sb);
  for (const n of nodes) { n._h.click(); text += " " + visibleText(sb); }

  ok(text.indexOf("realname-app") === -1,
    "app id leaked with anonymize on -- it appears in the run id, goal, paths or notes");
  ok(text.indexOf("localdev") === -1,
    "the local account name leaked out of an absolute path with anonymize on");
  ok(text.indexOf("deregistered-tool") === -1,
    "an app known only as a sibling directory must still be redacted -- the registry does not list every app");
  ok(text.indexOf("brandname") === -1,
    "a bare stem (brandname, from brandname-site) should resolve to the same label as its full id");
  ok(text.indexOf("dev@example.com") === -1, "an email address should be redacted");
  ok(text.indexOf("App 1") !== -1, "anonymize should still label the app as App N");
  ok(text.indexOf("2026-09-01") !== -1,
    "only the app name is redacted -- the run's date should survive so runs stay tellable apart");
  ok((sb.roots.fleetpath.textContent || "").indexOf("graph_agents") !== -1,
    "the fleet is not an app and keeps its name");

  // data-* attributes drive node lookup and must keep their real values
  ok(!!sb.roots.rundetail.querySelector('[data-node="builder:s1"]'),
    "scrubbing must not touch data-* attributes -- node selection depends on them");
}

// A payload from a server too old to send `siblings` must still render. The reader rule
// here is the same one serve.py follows: a missing input is a state, not a crash.
async function testAnonymizeWithoutSiblings() {
  console.log("anonymize works on a payload with no siblings list");
  const fx = identityLeakFixture();
  delete fx.siblings;
  const sb = makeSandbox(fx, { anon: true });
  await wait(50);
  const text = visibleText(sb);
  ok(text.indexOf("realname-app") === -1, "registered ids must still be redacted with no siblings list");
  ok(text.indexOf("App 1") !== -1, "labels should still render with no siblings list");
}

async function testNoFleetBanner() {
  console.log("no fleet found renders a banner in all three views, not a crash");
  const sb = makeSandbox(noFleetFixture());
  await wait(50);

  ["rundetail", "view-portfolio", "view-roster"].forEach((id) => {
    const texts = sb.all(sb.roots[id]).map((n) => n._text).filter(Boolean);
    ok(texts.some((t) => /No fleet directory found/.test(t)), id + " should show the no-fleet banner");
  });
}

async function testRouterDeepLinkAndClicks() {
  console.log("router: deep link on load, node click replaces, run click pushes");
  const sb = makeSandbox(baseFixture(), { initialHash: "#runs?run=run-parked&node=scout" });
  await wait(50);

  ok(sb.fetchLog.length === 1, "deep-linked load should still fetch exactly once");

  sb.historyLog.length = 0;
  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  cards[0]._h.click();   // switch to run-done (a different run than the deep-linked one)
  ok(sb.historyLog.length === 1 && sb.historyLog[0][0] === "push",
    "switching to a different run should pushState once, got " + JSON.stringify(sb.historyLog));

  sb.historyLog.length = 0;
  const nodes = sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"] && n._h && n._h.click);
  nodes[0]._h.click();
  ok(sb.historyLog.length === 1 && sb.historyLog[0][0] === "replace",
    "selecting a node should replaceState once (no history spam), got " + JSON.stringify(sb.historyLog));

  ok(sb.fetchLog.length === 1, "run/node selection must never trigger a refetch, got " + sb.fetchLog.length + " fetches");

  // The same rule under a SPLIT payload, where selecting a RUN may now cost one
  // request: selecting a NODE still may not, ever. That is the half of the old
  // invariant which was not traded, and it is the most frequent click in the app.
  const split = splitFixture(baseFixture());
  const sb2 = makeSandbox(split.list, { details: split.details, initialHash: "#runs?run=run-done" });
  await wait(50);
  const nodes2 = sb2.all(sb2.roots.rundetail).filter((n) => n._attrs["data-node"] && n._h && n._h.click);
  ok(nodes2.length === 7, "the deep-linked run's depth should have landed, got " + nodes2.length + " nodes");
  sb2.fetchLog.length = 0;
  nodes2.forEach((n) => n._h.click());       // select every node kind
  nodes2.forEach((n) => n._h.click());       // and deselect it again
  await wait(20);
  ok(sb2.fetchLog.length === 0,
    "selecting a node must fetch nothing, split payload or not, got " + JSON.stringify(sb2.fetchLog));
}

async function testTabSwitchPushes() {
  console.log("router: switching tabs pushes a real, reachable navigation");
  const sb = makeSandbox(baseFixture());
  await wait(50);

  const tabsClick = sb.roots.tabs._h && sb.roots.tabs._h.click;
  ok(!!tabsClick, "no click handler registered on #tabs");
  if (!tabsClick) return;

  const portfolioTab = sb.context.document.createElement("button");
  portfolioTab.className = "tab";
  portfolioTab.dataset.view = "portfolio";
  sb.historyLog.length = 0;
  tabsClick({ target: portfolioTab });
  ok(sb.historyLog.length === 1 && sb.historyLog[0][1] === "#portfolio",
    "tab switch should push #portfolio, got " + JSON.stringify(sb.historyLog));
}

async function testFleetSwitcherAndAutoRefresh() {
  console.log("multi-fleet: switcher populates, switching refetches, auto-refresh reacts to active runs");
  const fixture = baseFixture();
  const fleetA = fixture.fleets[0];
  const fleetB = { id: "C:\\fleets\\b", label: "b", path: "C:\\fleets\\b", found: true };
  fixture.fleets.push(fleetB);

  const sb = makeSandbox(fixture);
  await wait(50);

  const sel = sb.roots.fleetselect;
  ok(sel.style.display !== "none", "fleet switcher should be visible with 2 fleets registered");
  ok(sel._opts.length === 2, "expected 2 fleet options, got " + sel._opts.length);
  ok(sb.roots.livedot.style.display === "none", "no active-status run yet -- live indicator should be hidden");

  const activeRun = Object.assign({}, fixture.runs[0], { run_id: "live-run", status: "building" });
  sb.setPayload(Object.assign({}, fixture, {
    active_fleet_id: fleetB.id,
    fleet: { found: true, path: fleetB.path, searched: [] },
    runs: [activeRun]
  }));

  sb.fetchLog.length = 0;
  sb.timerLog.length = 0;
  const onChange = sel._h && sel._h.change;
  ok(!!onChange, "no change handler on the fleet switcher");
  if (onChange) {
    onChange({ target: { value: fleetB.id } });
    await wait(50);
    ok(sb.fetchLog.some((u) => u.indexOf(encodeURIComponent(fleetB.id)) !== -1),
      "switching fleets should fetch with the new fleet id, got " + JSON.stringify(sb.fetchLog));
    ok(sb.roots.livedot.style.display !== "none",
      "fleet B has a building run -- live indicator should now be visible");
    ok(sb.timerLog.some((ms) => ms >= 1000), "expected a >=1s auto-refresh timer to be scheduled while a run is active");
  }
}

// ---------------------------------------------------------------------

// The activity lane is optional: a fleet may write no heartbeat, and runs older than
// it have none. Both cases have to render, and the run WITHOUT a lane is the one that
// would break silently, so it is asserted explicitly rather than assumed.
async function testActivityLaneIsOptional() {
  console.log("activity lane renders when present and vanishes when absent");
  const fx = baseFixture();
  const now = Math.floor(Date.now() / 1000);
  fx.runs[0]._activity = {
    total: 5, skipped: 0,
    agents: [
      { agent: "scout", tools: 3, spawns: 1, first: now - 40, last: now - 10, open: 0 },
      { agent: "builder", tools: 2, spawns: 1, first: now - 8, last: now, open: 1 }
    ],
    tail: [
      { t: now - 40, ev: "start", agent: "scout", id: "a1" },
      { t: now - 39, ev: "tool", agent: "scout", id: "a1", tool: "Grep" },
      { t: now - 10, ev: "stop", agent: "scout", id: "a1" },
      { t: now - 8, ev: "start", agent: "builder", id: "a2" },
      { t: now, ev: "tool", agent: "builder", id: "a2", tool: "Edit" }
    ]
  };

  const sb = makeSandbox(fx);
  await wait(50);
  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);

  cards[0]._h.click();                      // run-done: has a lane
  let rows = sb.all(sb.roots.rundetail).filter((n) => (n.className || n._attrs.class || "") === "actrow");
  ok(rows.length === 2, "expected one activity row per agent (2), got " + rows.length);

  let text = sb.all(sb.roots.rundetail).map((n) => n.textContent || "").join(" ");
  ok(text.indexOf("scout") !== -1 && text.indexOf("builder") !== -1,
    "activity lane should name both agents");
  ok(text.indexOf("running") !== -1, "the agent with an open spawn should be marked running");
  ok(text.indexOf("3 tools") !== -1, "scout's tool count should render");
  ok(text.indexOf("5 events") !== -1, "the lane should report its event total");

  cards[1]._h.click();                      // run-parked: no _activity at all
  rows = sb.all(sb.roots.rundetail).filter((n) => (n.className || n._attrs.class || "") === "actrow");
  ok(rows.length === 0, "a run with no heartbeat must render no activity rows, got " + rows.length);
  text = sb.all(sb.roots.rundetail).map((n) => n.textContent || "").join(" ");
  ok(text.indexOf("activity") === -1, "a run with no heartbeat must not render the lane heading");
}

// A dropped request used to end auto-refresh for the life of the page: the timer was
// rescheduled only on success, while the livedot from the previous cycle stayed lit --
// so the page looked live and was frozen. The retry path is the fix, and it is invisible
// from the UI, so it gets an explicit test.
async function testFetchFailureKeepsPolling() {
  console.log("a failed fetch banners globally and keeps the poll alive");
  const sb = makeSandbox(baseFixture());     // no active run in this fixture
  await wait(50);

  ok(sb.roots.connbanner.style.display === "none", "no banner while the server is healthy");
  sb.timerLog.length = 0;
  ok(!sb.timerLog.some((ms) => ms >= 1000),
    "a healthy load with no active run should schedule no poll");

  sb.setFetchFails(true);
  sb.roots.refresh._h.click();
  await wait(50);

  ok(sb.roots.connbanner.style.display !== "none", "a failed fetch should show the global banner");
  ok(/serve\.py/.test(sb.roots.connbanner.textContent || ""),
    "the banner should name the thing that died, got: " + sb.roots.connbanner.textContent);
  ok(sb.timerLog.some((ms) => ms >= 1000),
    "a failed fetch must still schedule a retry, even with no run active");

  // and it recovers on its own once the server is back
  sb.setFetchFails(false);
  sb.firePoll();
  await wait(50);
  ok(sb.roots.connbanner.style.display === "none",
    "a successful poll after a failure should clear the banner");
}

// The 4s poll used to rebuild the detail pane unconditionally. `generated` changes on
// every request, so "did anything change" has to ignore it or the answer is always yes.
async function testSilentPollSkipsRenderWhenNothingChanged() {
  console.log("a silent poll re-renders only when the fleet actually moved");
  const fx = baseFixture();
  fx.runs[0].status = "building";            // gives us a live run, so a poll is scheduled
  const sb = makeSandbox(fx);
  await wait(50);

  const before = sb.roots.rundetail._children[0];
  ok(!!before, "run detail should have rendered something to compare against");

  // same fleet state, new request stamp -- the only difference a quiet 4s brings
  const same = Object.assign({}, fx, { generated: new Date(Date.now() + 4000).toISOString() });
  sb.setPayload(same);
  sb.firePoll();
  await wait(50);

  ok(sb.roots.rundetail._children[0] === before,
    "an unchanged silent poll must not tear down and rebuild the detail pane");
  ok((sb.roots.stamp.textContent || "").length > 0,
    "the read-at stamp should still update so the page does not look stalled");

  // now something really changes on disk
  const moved = JSON.parse(JSON.stringify(fx));
  moved.runs[0].status = "done";
  moved.generated = new Date(Date.now() + 8000).toISOString();
  sb.setPayload(moved);
  sb.firePoll();
  await wait(50);

  ok(sb.roots.rundetail._children[0] !== before,
    "a silent poll that finds new state must re-render");
}

// Long fields collapse to an excerpt; the 4s poll rebuilds the pane from scratch, so
// without keyed state an expanded gate_results snaps shut under the reader mid-run.
async function testExpandedNoteSurvivesRefresh() {
  console.log("an expanded long field stays open across a re-render");
  const fx = baseFixture();
  fx.runs[0].status = "building";
  fx.runs[0].builders.s1.gate_results = "GATE 1 ok. " + "x".repeat(600);
  const sb = makeSandbox(fx);
  await wait(50);

  const builderNode = sb.roots.rundetail.querySelector('[data-node="builder:s1"]');
  ok(!!builderNode, "expected a builder node to click");
  builderNode._h.click();

  function toggle() {
    return sb.all(sb.roots.rundetail)
      .find((n) => (n.className || "") === "note-toggle");
  }
  const btn = toggle();
  ok(!!btn, "a >260 char gate_results should render a show-full toggle");
  ok(/show full/.test(btn.textContent || ""), "toggle should start collapsed");
  btn._h.click();
  ok(/show less/.test(toggle().textContent || ""), "clicking should expand it");

  const moved = JSON.parse(JSON.stringify(fx));
  moved.runs[0].log = ["orchestrator: something new"];
  moved.generated = new Date(Date.now() + 4000).toISOString();
  sb.setPayload(moved);
  sb.firePoll();
  await wait(50);

  ok(/show less/.test((toggle() || {}).textContent || ""),
    "the expanded block must still be open after the poll re-rendered the pane");
}

// A 304 is success, not failure, and it carries no body. The page must keep the DATA it
// already has (replacing it with nothing empties the screen every 4s), skip the
// re-render, still move the clock, and still schedule the next poll -- an unbroken run
// of 304s while a node is thinking is the normal case here, not an edge one.
async function test304KeepsDataAndKeepsPolling() {
  console.log("a 304 stamps the clock, keeps DATA, and keeps the poll alive");
  const fx = baseFixture();
  fx.runs[0].status = "building";                          // a live run, so a poll is scheduled
  fx.generated = new Date(Date.now() - 60000).toISOString();  // old enough that the stamp visibly moves
  const sb = makeSandbox(fx, { etag: '"abc123"' });
  await wait(50);

  ok(!("If-None-Match" in sb.fetchHeaders[0]),
    "the first load, holding no ETag, must not send If-None-Match");
  const before = sb.roots.rundetail._children[0];
  ok(!!before, "run detail should have rendered something to compare against");
  const stampBefore = sb.roots.stamp.textContent;

  sb.timerLog.length = 0;
  sb.firePoll();
  await wait(50);

  ok(sb.fetchHeaders[1] && sb.fetchHeaders[1]["If-None-Match"] === '"abc123"',
    "the poll should send back the ETag the server gave us, got " + JSON.stringify(sb.fetchHeaders[1]));
  ok(sb.roots.rundetail._children[0] === before,
    "a 304 must not tear down and rebuild the detail pane");
  ok((sb.roots.stamp.textContent || "") !== stampBefore && (sb.roots.stamp.textContent || "").length > 0,
    "a 304 should still move the read-at stamp so the page does not look stalled");
  ok(sb.roots.connbanner.style.display === "none",
    "a 304 is success -- it must not raise the connection banner");
  ok(sb.timerLog.some((ms) => ms >= 1000),
    "a 304 must still schedule the next poll, or one unchanged response ends auto-refresh");

  // three more in a row: the poll has to survive an unbroken run of them
  for (let i = 0; i < 3; i++) { sb.timerLog.length = 0; sb.firePoll(); await wait(20); }
  ok(sb.timerLog.some((ms) => ms >= 1000), "the poll must survive a run of 304s");

  // DATA itself is private to the script, so prove it survived the way a reader would:
  // force a full re-render (the Anonymize toggle rebuilds everything from DATA) and see
  // both runs and the fleet come back. A cleared DATA renders an empty list and "no fleet".
  sb.roots.anon._h.click();
  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  ok(cards.length === 2,
    "a 304 must not clear DATA -- re-rendering from it should still find both runs, got " + cards.length);
  ok((sb.roots.fleetpath.textContent || "") !== "no fleet" && (sb.roots.fleetpath.textContent || "").length > 0,
    "a 304 must not clear the fleet, got " + JSON.stringify(sb.roots.fleetpath.textContent));
  sb.roots.anon._h.click();

  // and when the fleet really moves the server answers 200 again and the page re-renders
  const rendered = sb.roots.rundetail._children[0];
  const moved = JSON.parse(JSON.stringify(fx));
  moved.runs[0].status = "done";
  sb.setPayload(moved);
  sb.setEtag('"def456"');
  sb.firePoll();
  await wait(50);
  ok(sb.roots.rundetail._children[0] !== rendered,
    "a changed payload (new ETag, plain 200) must re-render");
}

// The conditional request is optional in both directions: a client holding nothing asks
// unconditionally and gets a normal 200 -- that is every first load and every fleet
// switch -- and a server that has never heard of ETags keeps working unchanged.
async function testNoStoredEtagStillRendersFrom200() {
  console.log("a client holding no ETag gets a plain 200 and renders normally");
  const sb = makeSandbox(baseFixture(), { etag: '"abc123"' });
  await wait(50);

  ok(sb.fetchLog.length === 1, "initial load should fetch exactly once, got " + sb.fetchLog.length);
  ok(!("If-None-Match" in sb.fetchHeaders[0]), "nothing stored means nothing sent");
  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  ok(cards.length === 2, "the 200 body should have rendered both runs, got " + cards.length);
  ok(!!sb.roots.rundetail._children[0], "the run detail should have rendered from the 200");
  ok(sb.roots.connbanner.style.display === "none", "a 200 raises no banner");

  // an old server, sending no ETag header at all, is served the same way
  const old = makeSandbox(baseFixture(), { etag: null });
  await wait(50);
  const oldCards = old.all(old.roots.runlist).filter((n) => n._h && n._h.click);
  ok(oldCards.length === 2, "a server with no ETag support must still render, got " + oldCards.length);
  old.roots.refresh._h.click();
  await wait(50);
  ok(old.fetchHeaders[1] && !("If-None-Match" in old.fetchHeaders[1]),
    "with no ETag ever received, no conditional header is ever sent");
}

// ---------------------------------------------------------------------
// the three shipped-but-unused state.json fields, rendered as signals
// ---------------------------------------------------------------------

function detailText(sb) {
  return sb.all(sb.roots.rundetail).map((n) => n.textContent || "").join(" ");
}
function scopePaths(sb) {
  return sb.all(sb.roots.rundetail)
    .filter((n) => (n.className || "").indexOf("scopepath") !== -1)
    .map((n) => n.textContent);
}
function provMarks(sb) {
  return sb.all(sb.roots.rundetail)
    .filter((n) => (n.className || "").indexOf("nprov") !== -1)
    .map((n) => ({ text: n.textContent, loud: (n.className || "").indexOf("bad") !== -1 }));
}

// Verbatim from .graph/runs/_schema.json: a fresh run copies this into
// scope_exceptions, so an untouched run has one entry and zero exceptions.
const SCHEMA_DOCSTRING =
  "ORCHESTRATOR-OWNED, normally empty. Paths a builder may write that the approved plan does not list. " +
  "guard-builder-scope.py DENIES a builder's Write/Edit outside architect.plan[].files, and this is the only " +
  "way through it. Adding one is a deliberate, recorded act: pair it with deviation_from_approved_plan on the " +
  "slice that needed it, and say why the gate's file set was wrong. Never add a path to silence the guard on " +
  "work the human did not approve.";

// The other half of a real grant: the orchestrator's rationale, which sits in the same
// array and quotes the very globs and endpoints it is explaining -- so it contains
// slashes and defeats a naive path test.
const WHY_RATIONALE =
  "WHY (orchestrator, 2026-09-01): this grants NOTHING the human did not approve. The approved file set for " +
  "s1/s2/s3 is the glob 'huntstack/apps/mobile/**', and guard-builder-scope.py matches literal prefixes, so " +
  "the directory the glob names had to be recorded here as well.";

// The seven real paths from 2026-09-02-date-accuracy, unchanged.
const SEVEN_REAL_PATHS = [
  "huntstack/packages/shared/src/index.ts",
  "huntstack/packages/shared/src/index.test.ts",
  "huntstack/packages/shared/package.json",
  "huntstack/packages/shared/vitest.config.ts",
  "huntstack/apps/web/src/pages/RegulationsPage.tsx",
  "huntstack/apps/api/src/lib/date-wire-format.test.ts",
  "huntstack/.github/workflows/ci.yml"
];

async function renderScopeExceptions(entries) {
  const fx = baseFixture();
  if (entries === null) delete fx.runs[0].scope_exceptions;
  else fx.runs[0].scope_exceptions = entries;
  const sb = makeSandbox(fx);
  await wait(50);
  return { paths: scopePaths(sb), text: detailText(sb), sb };
}

// scope_exceptions is the field where len() and a contains-a-slash test are both wrong,
// and wrong in opposite directions, on data that exists right now on this fleet.
async function testScopeExceptionsCountOnlyRealPaths() {
  console.log("scope exceptions count real paths, not the docstring and not the WHY prose");

  const fresh = await renderScopeExceptions([SCHEMA_DOCSTRING]);
  ok(fresh.paths.length === 0,
    "a run carrying only the schema docstring has granted nothing and must render ZERO exceptions, got " +
    fresh.paths.length);
  ok(!/scope exceptions/.test(fresh.text),
    "no real exception means no block at all, not an empty one");

  const seven = await renderScopeExceptions(SEVEN_REAL_PATHS.slice());
  ok(seven.paths.length === 7, "7 real paths must render 7, got " + seven.paths.length);
  ok(seven.paths.indexOf("huntstack/.github/workflows/ci.yml") !== -1,
    "a dotted directory in the path must not disqualify it, got " + JSON.stringify(seven.paths));
  ok(/scope exceptions/.test(seven.text), "a run with real exceptions must render the warning block");

  const mixed = await renderScopeExceptions(["huntstack/apps/mobile", WHY_RATIONALE]);
  ok(mixed.paths.length === 1,
    "a real path beside a WHY rationale is ONE exception -- the rationale quotes globs and would fool a " +
    "contains-a-slash test -- got " + mixed.paths.length + ": " + JSON.stringify(mixed.paths));
  ok(mixed.paths[0] === "huntstack/apps/mobile", "the surviving entry should be the path itself");

  // rationale prose that ENDS on the glob it is quoting: no sentence punctuation to
  // fall back on, so only "a path is one unbroken token" rejects it.
  const trailingGlob = await renderScopeExceptions([
    "fleetview/CLAUDE.md",
    "WHY (orchestrator, 2026-09-01): the approved file set for this slice was the glob huntstack/apps/mobile/**"
  ]);
  ok(trailingGlob.paths.length === 1,
    "prose ending on a glob is still prose, got " + JSON.stringify(trailingGlob.paths));
  ok(trailingGlob.paths[0] === "fleetview/CLAUDE.md", "the real path should be the one that survives");

  // a file at a repo root has no separator at all and is still a path
  const bare = await renderScopeExceptions(["CLAUDE.md"]);
  ok(bare.paths.length === 1, "a bare filename is a path, got " + JSON.stringify(bare.paths));

  // a directory with a space in it is still a path, and dropping it would silently
  // under-report the exact thing this block exists to surface
  const spaced = await renderScopeExceptions([
    "huntstack/apps/My App/src/x.ts",
    WHY_RATIONALE
  ]);
  ok(spaced.paths.length === 1,
    "a granted path containing a space must still count, got " + JSON.stringify(spaced.paths));
  ok(spaced.paths[0] === "huntstack/apps/My App/src/x.ts",
    "and it should be the spaced path that survives, not the rationale");

  // orchestrator-written field, so it can arrive as the wrong type entirely. CLAUDE.md:
  // a malformed input renders as a visible state, never as a crash.
  const malformed = await renderScopeExceptions("fleetview/CLAUDE.md");
  ok(malformed.paths.length === 0, "a non-array scope_exceptions renders no path rows");
  ok(/not a list/.test(malformed.text),
    "a non-array scope_exceptions should say so, got: " + malformed.text.slice(0, 200));
  ok(/work graph/.test(malformed.text),
    "and the rest of the run detail must still render -- a throw here truncates the pane");

  const none = await renderScopeExceptions(null);
  ok(none.paths.length === 0, "a run with no scope_exceptions key at all must render none, not crash");
  ok(!!none.sb.roots.rundetail._children[0], "and it must still render the run detail");

  const empty = await renderScopeExceptions([]);
  ok(empty.paths.length === 0, "an empty scope_exceptions array renders no block");
}

// A correctly-typed Array whose MEMBERS are junk used to be the silent case: every member
// filtered out by isRealPath, zero paths, no banner, and a pane byte-indistinguishable
// from a run that genuinely granted nothing. Three states, and the boundary between them
// is the whole point -- bannering the third would turn every fresh run on this fleet red.
async function testScopeExceptionsMalformedMembers() {
  console.log("scope exceptions: a junk MEMBER banners, a docstring-only list still does not");

  // (1) not a list at all -- the banner, and nothing else to render
  const notAList = await renderScopeExceptions("fleetview/CLAUDE.md");
  ok(/not a list/.test(notAList.text),
    "a non-array scope_exceptions still says it is not a list, got: " + notAList.text.slice(0, 200));
  ok(!/not a string/.test(notAList.text),
    "and it must NOT claim a member problem -- there is no member to have one");

  // (2a) [42, null] -- a real Array whose every member filters out
  const numbers = await renderScopeExceptions([42, null]);
  ok(/not a string/.test(numbers.text),
    "[42, null] is a real Array and must raise the member banner, got: " + numbers.text.slice(0, 200));
  ok(numbers.paths.length === 0, "[42, null] holds no real path, so no path rows, got " + numbers.paths.length);
  ok(/work graph/.test(numbers.text),
    "and the rest of the run detail must still render -- a throw here truncates the pane");

  // (2b) [{...}] -- the other shape orchestrator-written junk arrives in
  const objects = await renderScopeExceptions([{ path: "fleetview/CLAUDE.md", why: "s2" }]);
  ok(/not a string/.test(objects.text),
    "[{...}] must raise the member banner, got: " + objects.text.slice(0, 200));
  ok(objects.paths.length === 0, "an object entry is not a path row, got " + JSON.stringify(objects.paths));

  // (2c) the case the banner must not be allowed to swallow: real paths BESIDE a junk
  // member. Suppressing them to report the junk hides the grants this block exists for.
  const mixedJunk = await renderScopeExceptions([
    "huntstack/packages/shared/src/index.ts",
    42,
    "huntstack/.github/workflows/ci.yml"
  ]);
  ok(/not a string/.test(mixedJunk.text),
    "a list mixing real paths with a non-string member still banners, got: " + mixedJunk.text.slice(0, 200));
  ok(mixedJunk.paths.length === 2,
    "and it must ALSO render every real path the rest of the list held, got " + JSON.stringify(mixedJunk.paths));
  ok(mixedJunk.paths.indexOf("huntstack/packages/shared/src/index.ts") !== -1 &&
     mixedJunk.paths.indexOf("huntstack/.github/workflows/ci.yml") !== -1,
    "both real paths by name, got " + JSON.stringify(mixedJunk.paths));

  // (3) NOT malformed and never was: strings that all fail isRealPath. This is the
  // ordinary state of a fresh run -- 2 of the 8 runs holding the key on this fleet.
  const docstringOnly = await renderScopeExceptions([SCHEMA_DOCSTRING]);
  ok(!/not a string/.test(docstringOnly.text),
    "a docstring-only list is a list of strings and must raise NO malformed banner, got: " +
    docstringOnly.text.slice(0, 200));
  ok(!/scope exceptions/.test(docstringOnly.text),
    "and it must still render zero blocks -- this is what a fresh run looks like");
  ok(docstringOnly.paths.length === 0, "with zero path rows, got " + docstringOnly.paths.length);

  // the same in its other prose form, so the rule is read as "strings", not "the docstring"
  const whyOnly = await renderScopeExceptions([WHY_RATIONALE]);
  ok(!/not a string/.test(whyOnly.text), "a WHY rationale is a string and is not malformed either");
  ok(!/scope exceptions/.test(whyOnly.text), "and it renders no block");

  // an empty list is a list of strings vacuously: no banner, no block
  const emptyList = await renderScopeExceptions([]);
  ok(!/not a string/.test(emptyList.text), "an empty scope_exceptions raises NO malformed banner");
  ok(!/scope exceptions/.test(emptyList.text), "and renders zero blocks, not an empty one");
  ok(emptyList.paths.length === 0, "with zero path rows, got " + emptyList.paths.length);

  // an absent key is silent in exactly the same way
  const absent = await renderScopeExceptions(null);
  ok(!/not a string/.test(absent.text) && !/not a list/.test(absent.text),
    "an absent scope_exceptions key raises no banner of either kind");
}

// 31 of this fleet's 83 node keys carry no written_by and 13 still carry the schema's
// placeholder, against zero genuine mismatches. Anything that reads those as forgery is
// worse than showing nothing, so each of the four states gets an assertion.
async function testWrittenByFourStates() {
  console.log("written_by: unstamped and placeholder are muted, a different node is loud");

  // (1) a legacy run -- no written_by anywhere. baseFixture predates the field entirely.
  const legacy = makeSandbox(baseFixture());
  await wait(50);
  const legacyMarks = provMarks(legacy);
  ok(legacyMarks.length > 0, "an unstamped run should still mark its keys, got no marks at all");
  ok(legacyMarks.every((m) => !m.loud),
    "a run with no written_by anywhere must raise NO forgery warning, got " + JSON.stringify(legacyMarks));
  ok(legacyMarks.some((m) => /unstamped \(legacy\)/.test(m.text)),
    "a missing stamp should read as unstamped/legacy, got " + JSON.stringify(legacyMarks.map((m) => m.text)));

  // (2) every key stamped by the node that owns it -- the quiet state, no marks at all.
  const good = baseFixture();
  const gr = good.runs[0];
  gr.scout.written_by = "scout";
  gr.architect.written_by = "architect";
  gr.builders.s1.written_by = "builder";
  gr.reviews.s1.written_by = "reviewer";
  gr.integrator.written_by = "integrator";
  gr.ops.written_by = "ops";
  const okSb = makeSandbox(good);
  await wait(50);
  ok(provMarks(okSb).length === 0,
    "correctly stamped keys must be silent, got " + JSON.stringify(provMarks(okSb).map((m) => m.text)));

  // (3) the schema placeholder. It CONTAINS the expected node name ("...always the
  // string integrator"), so a substring match would call it correctly stamped.
  const tmpl = baseFixture();
  tmpl.runs[0].integrator.written_by =
    "the node that wrote this key - here, always the string integrator";
  const tmplSb = makeSandbox(tmpl);
  await wait(50);
  const tmplMarks = provMarks(tmplSb);
  ok(tmplMarks.some((m) => /did not run/.test(m.text)),
    "a placeholder written_by means the node never ran, got " + JSON.stringify(tmplMarks.map((m) => m.text)));
  ok(tmplMarks.every((m) => !m.loud), "a placeholder is muted, never a forgery warning");

  // (4) the one loud state: a key stamped with a node that may not write it.
  const forged = baseFixture();
  forged.runs[0].scout.written_by = "scout";
  forged.runs[0].architect.written_by = "architect";
  forged.runs[0].builders.s1.written_by = "orchestrator";
  const forgedSb = makeSandbox(forged);
  await wait(50);
  const loud = provMarks(forgedSb).filter((m) => m.loud);
  ok(loud.length === 1,
    "exactly one key names a different node and it must warn, got " + JSON.stringify(provMarks(forgedSb)));
  ok(loud.length === 1 && /orchestrator/.test(loud[0].text),
    "the warning should name the value actually on disk, got " + JSON.stringify(loud));

  // a reviewer stamped `builder` -- a builder reviewing itself -- is the same failure
  const selfReview = baseFixture();
  selfReview.runs[0].reviews.s1.written_by = "builder";
  const selfSb = makeSandbox(selfReview);
  await wait(50);
  ok(provMarks(selfSb).some((m) => m.loud && /builder/.test(m.text)),
    "reviews.<slice> stamped `builder` must warn -- a builder cannot review itself");

  // and the inspector explains it rather than just colouring it red
  const bNode = forgedSb.roots.rundetail.querySelector('[data-node="builder:s1"]');
  ok(!!bNode, "expected a builder node to inspect");
  if (bNode) {
    bNode._h.click();
    ok(/provenance —/.test(detailText(forgedSb)),
      "the inspector should carry the provenance sentence for the selected node");
  }
}

// _mtime is the run's state.json mtime. A node writes state.json only when it finishes,
// so a quiet one mid-node is normal and must never be worded as idleness. Only both
// clocks stopping on an active run is a signal.
async function testStateMtimeRendersRelativeAge() {
  console.log("_mtime renders as a relative age, and only a wedged run is flagged");

  const fresh = baseFixture();
  fresh.runs[0]._mtime = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const sb = makeSandbox(fresh);
  await wait(50);
  const text = detailText(sb);
  ok(/state written 4m ago/.test(text),
    "the run header should show the state.json age as a relative span, got: " + text.slice(0, 300));
  ok(!/idle/i.test(text), "a quiet state.json must never be worded as idle");

  // an older server, or an unreadable run: no _mtime at all
  const bare = baseFixture();
  delete bare.runs[0]._mtime;
  const bareSb = makeSandbox(bare);
  await wait(50);
  ok(!/state written/.test(detailText(bareSb)), "no _mtime means no age claim");
  ok(!!bareSb.roots.rundetail._children[0], "a run with no _mtime must still render");

  // Every fixture below has BOTH clocks stale, so the only thing that can suppress the
  // pill is the rule under test. An assertion resting on a fresh _mtime, or on a run
  // with no _activity, passes for the wrong reason and cannot catch a deleted guard.
  const staleSecs = Math.floor(Date.now() / 1000) - 40 * 60;
  function bothClocksStale(status, lastSecs) {
    const fx = baseFixture();
    fx.runs[0].status = status;
    fx.runs[0]._mtime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
    if (lastSecs !== null) {
      fx.runs[0]._activity = {
        total: 2, skipped: 0,
        agents: [{ agent: "builder", tools: 1, spawns: 1, first: lastSecs - 30, last: lastSecs, open: 1 }],
        tail: [{ t: lastSecs, ev: "tool", agent: "builder", id: "a1", tool: "Edit" }]
      };
    }
    return fx;
  }
  const withActivity = (lastSecs) => bothClocksStale("building", lastSecs);

  const wedged = makeSandbox(withActivity(staleSecs));
  await wait(50);
  ok(/no state or activity for 40m/.test(detailText(wedged)),
    "an active run whose state.json AND heartbeat have both stopped is wedged and must be flagged");

  // A finished run is silent because it is finished. Both clocks are stale here, so the
  // status guard is the only thing standing between this fixture and a red pill on all
  // seven `done` runs in the real fleet.
  const finished = makeSandbox(bothClocksStale("done", staleSecs));
  await wait(50);
  ok(!/no state or activity/.test(detailText(finished)),
    "a done run has both clocks stopped for the obvious reason and must never be flagged wedged");

  // And the case that actually fired on this fleet: a run parked at the human gate is
  // quiet BY DESIGN -- no node is running, so neither clock can move. Flagging it puts a
  // red pill on every gated run and teaches the reader to ignore the real one.
  const gated = makeSandbox(bothClocksStale("awaiting-approval", staleSecs));
  await wait(50);
  const gatedText = detailText(gated);
  ok(!/no state or activity/.test(gatedText),
    "a run waiting at the human gate is correctly quiet, not wedged -- it is blocked on a person");
  ok(/state written 40m ago/.test(gatedText),
    "the age still renders on a gated run; it is the wedged claim that is withheld");

  const thinking = makeSandbox(withActivity(Math.floor(Date.now() / 1000)));
  await wait(50);
  const thinkingText = detailText(thinking);
  ok(/state written 40m ago/.test(thinkingText),
    "the age still renders while a node is mid-work, got: " + thinkingText.slice(0, 300));
  ok(!/no state or activity/.test(thinkingText),
    "a run whose heartbeat is still moving is NOT wedged, however old its state.json is");

  const noHeartbeat = makeSandbox(withActivity(null));
  await wait(50);
  ok(!/no state or activity/.test(detailText(noHeartbeat)),
    "with no activity.jsonl there is only one clock, so nothing may be claimed about wedging");
}

// s1 put the 304 branch ahead of the opts.silent check, so Refresh started returning
// without re-rendering. An explicit user action asks unconditionally and always gets a
// 200; the 4s poll -- the request that actually repeats -- still asks conditionally.
async function testRefreshBypassesConditionalRequest() {
  console.log("Refresh always asks unconditionally; only the silent poll sends If-None-Match");
  const fx = baseFixture();
  fx.runs[0].status = "building";              // an active run, so a poll gets scheduled
  const sb = makeSandbox(fx, { etag: '"abc123"' });
  await wait(50);
  ok(!("If-None-Match" in sb.fetchHeaders[0]), "the first load holds no ETag and sends none");

  const before = sb.roots.rundetail._children[0];
  ok(!!before, "run detail should have rendered something to compare against");

  sb.roots.refresh._h.click();
  await wait(50);
  ok(sb.fetchHeaders[1] && !("If-None-Match" in sb.fetchHeaders[1]),
    "Refresh must not send If-None-Match, got " + JSON.stringify(sb.fetchHeaders[1]));
  ok(sb.roots.rundetail._children[0] !== before,
    "Refresh gets a 200 and rebuilds the pane -- forcing a redraw is what the button is for");

  const afterRefresh = sb.roots.rundetail._children[0];
  sb.firePoll();
  await wait(50);
  ok(sb.fetchHeaders[2] && sb.fetchHeaders[2]["If-None-Match"] === '"abc123"',
    "the silent poll must still ask conditionally -- that is where the 304 win is, got " +
    JSON.stringify(sb.fetchHeaders[2]));
  ok(sb.roots.rundetail._children[0] === afterRefresh,
    "and its 304 still short-circuits the re-render");
}

// ---------------------------------------------------------------------
// the split: a light run list, and one run's depth fetched on selection
//
// These cases exist to hold the amended selection rule to what it still forbids.
// Selection was allowed to fetch; it was not allowed to feel slow, to blank the pane,
// to spam the network, or to touch the poll. Each of those has its own assertion.
// ---------------------------------------------------------------------

async function testSplitSelectionFetchesOnceThenCaches() {
  console.log("split: an uncached run costs one request, a re-selected one costs none");
  const fx = baseFixture();
  const live = JSON.parse(JSON.stringify(fx.runs[0]));
  live.run_id = "run-live";
  live.status = "building";
  live.goal = "a run still moving";
  live.architect.plan = [
    { slice: "s1", intent: "first", files: ["a.py"], done_when: "tests pass" },
    { slice: "s2", intent: "second", files: ["b.py"], done_when: "tests pass" }
  ];
  live.builders = {
    s1: { status: "done", branch: "master", changed: ["a.py"], notes: "" },
    s2: { status: "done", branch: "master", changed: ["b.py"], notes: "" }
  };
  fx.runs.push(live);

  const { list, details } = splitFixture(fx);
  const sb = makeSandbox(list, { details });
  await wait(50);

  ok(sb.fetchLog.length === 2,
    "a split load asks for the list and the selected run's detail, got " + JSON.stringify(sb.fetchLog));
  ok(/runs=light/.test(sb.fetchLog[0]), "the list request must ask for light rows, got " + sb.fetchLog[0]);
  ok(detailFetches(sb).length === 1 && /run=run-done/.test(detailFetches(sb)[0]),
    "exactly one detail request, naming the selected run, got " + JSON.stringify(detailFetches(sb)));
  ok(sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"]).length === 7,
    "the depth should have landed and drawn the work graph");

  // a node click inside a loaded run: the surviving half of the old invariant
  sb.fetchLog.length = 0;
  const nodes = sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"] && n._h && n._h.click);
  nodes.forEach((n) => n._h.click());
  await wait(20);
  ok(sb.fetchLog.length === 0, "a node click must fetch nothing, got " + JSON.stringify(sb.fetchLog));

  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  ok(cards.length === 3, "expected 3 run cards, got " + cards.length);

  // an uncached run: the header is on screen BEFORE the request goes out, built from
  // the light row alone -- including the pills the row pre-computes so they do not pop
  // in when the depth lands.
  sb.fetchLog.length = 0;
  cards[2]._h.click();
  const immediate = detailText(sb);
  ok(/run-live/.test(immediate), "the header must paint synchronously from the light row");
  ok(/a run still moving/.test(immediate), "including the goal the row carries");
  ok(/2 slices/.test(immediate) && /1 reject loop/.test(immediate),
    "_n_slices and _n_rejects pre-paint their pills, got: " + immediate.slice(0, 400));
  ok(/loading run detail/.test(immediate), "and a stated loading panel where the depth will land");
  ok(!/ship the thing/.test(immediate),
    "the previous run's detail must never sit on screen under a new run's id");
  ok(sb.fetchLog.length === 1 && /run=run-live/.test(sb.fetchLog[0]),
    "an uncached run costs exactly ONE request, naming that run, got " + JSON.stringify(sb.fetchLog));

  await wait(50);
  ok(!/loading run detail/.test(detailText(sb)), "the depth replaces the loading panel when it lands");
  ok(sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"]).length > 7,
    "and a 2-slice run draws more nodes than a 1-slice one");

  // back and forth between two runs that are both cached and neither of which moved
  sb.fetchLog.length = 0;
  cards[0]._h.click(); await wait(20);
  cards[2]._h.click(); await wait(20);
  ok(sb.fetchLog.length === 0,
    "a re-selected, unmoved run must send nothing at all, got " + JSON.stringify(sb.fetchLog));
  ok(/a run still moving/.test(detailText(sb)), "and it renders from the cache");
}

async function testSplitPollRefetchesOnlyWhenTheRowMoved() {
  console.log("split: a poll refetches the selected run only when its light row moved");
  const fx = baseFixture();
  const now = Math.floor(Date.now() / 1000);
  fx.runs[0].status = "building";
  fx.runs[0]._mtime = new Date().toISOString();
  fx.runs[0]._activity = {
    total: 4, skipped: 0,
    agents: [{ agent: "builder", tools: 2, spawns: 1, first: now - 20, last: now, open: 1 }],
    tail: [{ t: now, ev: "tool", agent: "builder", id: "a1", tool: "Edit" }]
  };
  const { list, details } = splitFixture(fx);
  const sb = makeSandbox(list, { details });
  await wait(50);
  ok(detailFetches(sb).length === 1, "the selected run's detail is fetched once on load");

  // a poll on which nothing in the run actually moved. This is the case the raw byte
  // counts miss: a selected ACTIVE run whose node is thinking without writing costs
  // one 5 KB list request, not its whole detail.
  const quiet = JSON.parse(JSON.stringify(list));
  quiet.generated = new Date(Date.now() + 4000).toISOString();
  sb.setPayload(quiet);
  sb.fetchLog.length = 0;
  sb.firePoll(); await wait(50);
  ok(listFetches(sb).length === 1, "a poll always asks for the list");
  ok(detailFetches(sb).length === 0,
    "an unmoved row must cost NO detail request, got " + JSON.stringify(sb.fetchLog));

  // the heartbeat appended: two events inside one float tick leave _activity_last
  // where it was, so _activity_n is the only thing that can see this move.
  details["run-done"].log = ["orchestrator: a line only the refetched detail has"];
  const ticked = JSON.parse(JSON.stringify(list));
  ticked.runs[0]._activity_n = 5;
  ticked.generated = new Date(Date.now() + 8000).toISOString();
  sb.setPayload(ticked); sb.setDetails(details);
  sb.fetchLog.length = 0;
  sb.firePoll(); await wait(50);
  ok(detailFetches(sb).length === 1,
    "a moved _activity_n refetches the selected run exactly once, got " + JSON.stringify(sb.fetchLog));
  ok(/only the refetched detail has/.test(detailText(sb)), "and the pane shows the refetched depth");

  // a node finished and wrote state.json: _mtime moves
  const written = JSON.parse(JSON.stringify(ticked));
  written.runs[0]._mtime = new Date(Date.now() + 60000).toISOString();
  written.generated = new Date(Date.now() + 12000).toISOString();
  sb.setPayload(written);
  sb.fetchLog.length = 0;
  sb.firePoll(); await wait(50);
  ok(detailFetches(sb).length === 1,
    "a moved _mtime refetches the selected run too, got " + JSON.stringify(sb.fetchLog));

  // and a run that is NOT selected is never fetched, however much it moves
  const other = JSON.parse(JSON.stringify(written));
  other.runs[1]._mtime = new Date(Date.now() + 90000).toISOString();
  other.runs[1]._activity_n = 9;
  other.generated = new Date(Date.now() + 16000).toISOString();
  sb.setPayload(other);
  sb.fetchLog.length = 0;
  sb.firePoll(); await wait(50);
  ok(detailFetches(sb).length === 0,
    "depth is fetched for the SELECTED run and nothing else -- no prefetch, no watching two runs");
}

async function testSplitFleetSwitchAndRefreshDropTheCache() {
  console.log("split: a fleet switch and Refresh each drop every cached detail and every ETag");
  const fleetB = { id: "C:\\fleets\\b", label: "b", path: "C:\\fleets\\b", found: true };

  const fxA = baseFixture();
  fxA.fleets.push(fleetB);
  fxA.runs[0].log = ["orchestrator: this line exists only in fleet A"];
  const A = splitFixture(fxA);
  const sb = makeSandbox(A.list, { details: A.details, etag: '"listA"', detailEtag: '"detailA"' });
  await wait(50);
  ok(/only in fleet A/.test(detailText(sb)), "fleet A's run-done detail should be on screen");

  // fleet B holds a run with the SAME id and different contents -- the collision a
  // cache that outlived the switch would render wrong.
  const fxB = baseFixture();
  fxB.fleets.push(fleetB);
  fxB.active_fleet_id = fleetB.id;
  fxB.fleet = { found: true, path: fleetB.path, searched: [] };
  fxB.runs[0].log = ["orchestrator: this line exists only in fleet B"];
  const B = splitFixture(fxB);
  sb.setPayload(B.list); sb.setDetails(B.details);
  sb.setEtag('"listB"'); sb.setDetailEtag('"detailB"');

  sb.fetchLog.length = 0; sb.fetchHeaders.length = 0;
  sb.roots.fleetselect._h.change({ target: { value: fleetB.id } });
  await wait(50);
  ok(detailFetches(sb).length === 1,
    "the same run id under a new fleet must be refetched, got " + JSON.stringify(sb.fetchLog));
  ok(/only in fleet B/.test(detailText(sb)), "fleet B's run must render");
  ok(!/only in fleet A/.test(detailText(sb)),
    "fleet A's cached run must NEVER render under fleet B");
  ok(sb.fetchHeaders.every((h) => !("If-None-Match" in h)),
    "a fleet switch sends no conditional header on either request, got " + JSON.stringify(sb.fetchHeaders));

  // Refresh means "rebuild the page now", and a cache surviving it would make the
  // button a lie. It already forces a 200 on the list; it must do the same per run.
  sb.fetchLog.length = 0; sb.fetchHeaders.length = 0;
  sb.roots.refresh._h.click();
  await wait(50);
  ok(listFetches(sb).length === 1 && detailFetches(sb).length === 1,
    "Refresh drops the cache, so the selected run's detail is asked for again, got " + JSON.stringify(sb.fetchLog));
  ok(sb.fetchHeaders.every((h) => !("If-None-Match" in h)),
    "Refresh must send no If-None-Match on EITHER request, got " + JSON.stringify(sb.fetchHeaders));
  ok(/only in fleet B/.test(detailText(sb)), "and the rebuilt pane still shows the right fleet's run");
}

async function testSplitEtagsArePerUrl() {
  console.log("split: the list URL and a detail URL carry independent ETags");
  const fx = baseFixture();
  fx.runs[0].status = "building";                 // a live run, so polls get scheduled
  const { list, details } = splitFixture(fx);
  const sb = makeSandbox(list, { details, etag: '"list-token"', detailEtag: '"detail-token"' });
  await wait(50);
  ok(sb.fetchHeaders.every((h) => !("If-None-Match" in h)),
    "the first load holds no token and sends none, on either request");

  sb.fetchLog.length = 0; sb.fetchHeaders.length = 0;
  sb.firePoll(); await wait(50);
  ok(sb.fetchHeaders[0] && sb.fetchHeaders[0]["If-None-Match"] === '"list-token"',
    "the poll sends the LIST url's own token back, got " + JSON.stringify(sb.fetchHeaders[0]));
  // paired with its own URL: the objection is a detail token arriving on the LIST url,
  // not a conditional request as such.
  ok(sb.fetchLog.every((u, i) => !/[?&]runs=/.test(u) ||
      (sb.fetchHeaders[i] || {})["If-None-Match"] !== '"detail-token"'),
    "a detail ETag must never be sent on the list URL -- one variable for both is a false 304 waiting");

  // Lose the cached detail while the list keeps answering: the row moves, the detail
  // request dies, and the pane says so.
  sb.setDetailMode("reject");
  const moved = JSON.parse(JSON.stringify(list));
  moved.runs[0]._activity_n = 7;
  moved.generated = new Date(Date.now() + 4000).toISOString();
  sb.setPayload(moved);
  sb.setEtag('"list-token-2"');
  sb.firePoll(); await wait(50);
  ok(/Could not load this run's detail/.test(detailText(sb)),
    "a dead detail request leaves a stated pane, got: " + detailText(sb).slice(0, 300));

  // Now the list is unchanged and answers 304 -- and the still-missing detail must
  // STILL be asked for. A 304 on one URL cannot suppress a request on the other.
  sb.setDetailMode("ok");
  sb.fetchLog.length = 0; sb.fetchHeaders.length = 0;
  sb.firePoll(); await wait(50);
  ok(sb.fetchHeaders[0] && sb.fetchHeaders[0]["If-None-Match"] === '"list-token-2"',
    "the poll asks the list conditionally with the token that list gave it");
  ok(detailFetches(sb).length === 1,
    "a 304 on the list must not suppress a needed detail request, got " + JSON.stringify(sb.fetchLog));
  ok(!/Could not load/.test(detailText(sb)), "and the recovered detail replaces the failure pane");
}

async function testSplitDetailFailureStaysInsideTheDetailPane() {
  console.log("split: a 404 or a dead detail request renders in the pane and never touches the poll");
  const fx = baseFixture();
  fx.runs[1].status = "building";                 // keeps a poll scheduled throughout
  const { list, details } = splitFixture(fx);
  delete details["run-parked"];                   // deleted between the list and the click

  const sb = makeSandbox(list, { details });
  await wait(50);
  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  cards[1]._h.click();
  await wait(50);

  let text = detailText(sb);
  ok(/no longer in the fleet/.test(text),
    "a 404 renders a stated banner inside the detail pane, got: " + text.slice(0, 300));
  ok(/run-parked/.test(text), "and the header the light row could paint is still there");
  ok(sb.roots.connbanner.style.display === "none",
    "a detail 404 must NOT raise the connection banner -- load() owns that banner");
  let polled = true;
  try { sb.firePoll(); } catch (e) { polled = false; }
  ok(polled, "a detail 404 must leave the next poll scheduled");
  await wait(50);
  ok(sb.timerLog.some((ms) => ms >= 1000), "and the poll goes on rescheduling itself");

  // the same, for a request that dies outright rather than answering
  const sb2 = makeSandbox(list, { details });
  await wait(50);
  sb2.setDetailMode("reject");
  const cards2 = sb2.all(sb2.roots.runlist).filter((n) => n._h && n._h.click);
  sb2.timerLog.length = 0;
  cards2[1]._h.click();
  await wait(50);
  text = detailText(sb2);
  ok(/Could not load this run's detail/.test(text),
    "a rejected detail request renders inside the detail pane, got: " + text.slice(0, 300));
  ok(/run-parked/.test(text), "with the header still painted from the row");
  ok(sb2.roots.connbanner.style.display === "none",
    "a dead detail request must NOT raise the connection banner");
  let polled2 = true;
  try { sb2.firePoll(); } catch (e) { polled2 = false; }
  ok(polled2, "a dead detail request must leave the next poll scheduled");
  await wait(50);
  ok(sb2.timerLog.some((ms) => ms >= 1000), "and the poll survives it");
}

async function testSplitUnknownDeepLinkRendersStatedPane() {
  console.log("split: a deep link naming a run this fleet does not have says so");
  const { list, details } = splitFixture(baseFixture());
  const sb = makeSandbox(list, { details, initialHash: "#runs?run=does-not-exist" });
  await wait(50);

  const text = detailText(sb);
  ok(/not in this fleet/.test(text), "the pane must state that the run is not here, got: " + text.slice(0, 300));
  ok(/does-not-exist/.test(text), "and name the run the link asked for");
  ok(!/ship the thing/.test(text),
    "it must NOT silently fall back to runs[0] -- showing the wrong run's graph under this URL is worse");
  ok(detailFetches(sb).length === 0, "a run that is not in the list is never requested");
  ok(sb.fetchLog.length === 1, "so the load costs one request, got " + JSON.stringify(sb.fetchLog));

  // and the page is not stuck there: a real run still selects normally
  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  cards[0]._h.click();
  await wait(50);
  ok(/ship the thing/.test(detailText(sb)), "selecting a real run recovers from the stated pane");
}

async function testOldServerFullPayloadStillRenders() {
  console.log("split: an old server that ignores runs=light still renders exactly as today");
  const sb = makeSandbox(baseFixture());          // no runs_mode, and no detail endpoint at all
  await wait(50);

  ok(/runs=light/.test(sb.fetchLog[0]),
    "the page still ASKS for light rows; an old server just ignores the parameter");
  ok(sb.fetchLog.length === 1,
    "a payload with no runs_mode must trigger no detail fetch at all, got " + JSON.stringify(sb.fetchLog));
  ok(detailFetches(sb).length === 0, "not one request names a run");
  ok(sb.all(sb.roots.rundetail).filter((n) => n._attrs["data-node"]).length === 7,
    "and the run detail renders from the full runs[] exactly as before");

  const cards = sb.all(sb.roots.runlist).filter((n) => n._h && n._h.click);
  sb.fetchLog.length = 0;
  cards[1]._h.click(); await wait(20);
  cards[0]._h.click(); await wait(20);
  ok(sb.fetchLog.length === 0,
    "selection against an old server fetches nothing, exactly as it did, got " + JSON.stringify(sb.fetchLog));
  ok(/ship the thing/.test(detailText(sb)), "and the selected run still renders");
}

async function testWedgedReadsTheSameOffALightRow() {
  console.log("split: wedgedFor reads the same clock off _activity_last as off _activity");
  const staleSecs = Math.floor(Date.now() / 1000) - 40 * 60;
  const fx = baseFixture();
  fx.runs[0].status = "building";
  fx.runs[0]._mtime = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  // the newest event is in tail[], TEN MINUTES after the newest agents[].last, so a
  // clock taken over agents[] alone would read 50m where this one reads 40m.
  fx.runs[0]._activity = {
    total: 2, skipped: 0,
    agents: [{ agent: "builder", tools: 1, spawns: 1, first: staleSecs - 900, last: staleSecs - 600, open: 1 }],
    tail: [{ t: staleSecs, ev: "tool", agent: "builder", id: "a1", tool: "Edit" }]
  };

  const full = makeSandbox(fx);
  await wait(50);
  const mFull = /no state or activity for (\S+)/.exec(detailText(full));
  ok(!!mFull, "the full payload must flag this wedged run");

  // The light sandbox is given NO detail at all, so the header can only have read the
  // row: there is no _activity anywhere in the page.
  const { list } = splitFixture(fx);
  const light = makeSandbox(list, { details: {} });
  await wait(50);
  const lightText = detailText(light);
  const mLight = /no state or activity for (\S+)/.exec(lightText);
  ok(!!mLight, "a light row carrying only _activity_last must flag the same run");
  ok(!!mFull && !!mLight && mFull[1] === mLight[1],
    "and to the same span: full says " + (mFull && mFull[1]) + ", light says " + (mLight && mLight[1]));
  ok(/state written 40m ago/.test(lightText), "the state age renders off the row too");

  // a light row with no heartbeat clock at all has only one clock, so it claims nothing
  const noClock = JSON.parse(JSON.stringify(list));
  noClock.runs[0]._activity_last = null;
  noClock.runs[0]._activity_n = null;
  const bare = makeSandbox(noClock, { details: {} });
  await wait(50);
  ok(!/no state or activity/.test(detailText(bare)),
    "a light row with no heartbeat clock must claim nothing about wedging");
  ok(/state written 40m ago/.test(detailText(bare)), "while the state age still renders");
}

async function main() {
  const tests = [
    testRenderRegression,
    testRejectThenPassRendersFinalVerdict,
    testAnonymizeLeaksNothing,
    testAnonymizeHidesRunIdsGoalsAndPaths,
    testAnonymizeWithoutSiblings,
    testNoFleetBanner,
    testRouterDeepLinkAndClicks,
    testTabSwitchPushes,
    testFleetSwitcherAndAutoRefresh,
    testActivityLaneIsOptional,
    testFetchFailureKeepsPolling,
    testSilentPollSkipsRenderWhenNothingChanged,
    testExpandedNoteSurvivesRefresh,
    test304KeepsDataAndKeepsPolling,
    testNoStoredEtagStillRendersFrom200,
    testScopeExceptionsCountOnlyRealPaths,
    testScopeExceptionsMalformedMembers,
    testWrittenByFourStates,
    testStateMtimeRendersRelativeAge,
    testRefreshBypassesConditionalRequest,
    testSplitSelectionFetchesOnceThenCaches,
    testSplitPollRefetchesOnlyWhenTheRowMoved,
    testSplitFleetSwitchAndRefreshDropTheCache,
    testSplitEtagsArePerUrl,
    testSplitDetailFailureStaysInsideTheDetailPane,
    testSplitUnknownDeepLinkRendersStatedPane,
    testOldServerFullPayloadStillRenders,
    testWedgedReadsTheSameOffALightRow
  ];
  for (const t of tests) {
    try {
      await t();
    } catch (e) {
      failures++;
      console.log("  FAIL (threw): " + t.name + ": " + (e && e.stack || e));
    }
  }
  console.log("\n" + assertions + " assertions, " + failures + " failures");
  process.exit(failures ? 1 : 0);
}

main();
