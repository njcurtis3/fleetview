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
  const timerLog = [];
  let payload = initialPayload;

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
    fetch: (url) => { fetchLog.push(url); return Promise.resolve({ json: () => Promise.resolve(payload) }); },
    setTimeout: (fn, ms) => {
      timerLog.push(ms);
      if (ms >= 1000) return { __fakeTimer: true };   // never let the 4s poll actually recurse
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
    context, roots, historyLog, fetchLog, timerLog,
    setPayload(p) { payload = p; },
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

async function main() {
  const tests = [
    testRenderRegression,
    testRejectThenPassRendersFinalVerdict,
    testAnonymizeLeaksNothing,
    testNoFleetBanner,
    testRouterDeepLinkAndClicks,
    testTabSwitchPushes,
    testFleetSwitcherAndAutoRefresh
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
