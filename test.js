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
    testNoStoredEtagStillRendersFrom200
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
