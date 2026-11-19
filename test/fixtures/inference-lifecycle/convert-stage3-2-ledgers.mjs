// Developer tool, not run by `npm test`. It reduces Stage 3.2 lifecycle
// validation ledgers (kept outside this repository) to the lifecycle
// operations the pure request lifecycle consumes, and writes them as the
// replay fixtures next to this file.
//
//   node test/fixtures/inference-lifecycle/convert-stage3-2-ledgers.mjs <stage3.2-root>
//
// <stage3.2-root> contains ledgers/ (API-level runs) and ledgers-reach/
// (page-level runs on the committed pages). Every fixture records the
// source ledger's file name and sha256, so it can be checked against the
// original. Everything except the operations below is dropped: no user
// agent, URL, blob id, timing or image data is kept.
//
// Operations (one array per event, in ledger order):
//   ["start"]                 Analyze / Start handler ran (page ledgers)
//   ["newVideo"]              a video file was selected (page ledgers)
//   ["ended"]                 the video's ended event
//   ["dispatch", id]          pose.send() called (id = ledger send id)
//   ["warmup", id]            the phase's first send on instance 1 (API ledgers)
//   ["callback"]              the engine's onResults callback entered
//   ["settle", id, outcome]   that send's promise settled: "resolved" | "rejected"
//   ["reload"]                page reload; the next phase is a new document
//
// Page ledgers come from pages that issue no warm-up request, so their
// fixtures set engineReadyBeforeReplay. A page run in which a send was
// issued while another was outstanding is cut just before the first
// settlement after that overlap: from there on, the recorded engine
// behaviour was caused by the overlap, which the lifecycle refuses, so
// replaying it would be counterfactual.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2];
if (!root) throw new Error("usage: convert-stage3-2-ledgers.mjs <stage3.2-root>");

// [fixture name, group, ledger path relative to root, report section]
const PAGE = [
  ["c1-chase", "C1", "ledgers-reach/r32-c1-nv-early-chase-r1.ndjson"],
  ["c1-race", "C1", "ledgers-reach/r32-c1-nv-early-race-r1.ndjson"],
  ["c2-chase", "C2", "ledgers-reach/r32-c2-nv-pending-chase-r1.ndjson"],
  ["c2-race", "C2", "ledgers-reach/r32-c2-nv-pending-race-r1.ndjson"],
  ["c3-chase", "C3", "ledgers-reach/r32-c3-nv-hung-chase-r1.ndjson"],
  ["c3-race", "C3", "ledgers-reach/r32-c3-nv-hung-race-r1.ndjson"],
  ["c4-chase", "C4", "ledgers-reach/r32-c4-nvs-early-chase-r1.ndjson"],
  ["c4-race", "C4", "ledgers-reach/r32-c4-nvs-early-race-r1.ndjson"],
  ["c5-chase", "C5", "ledgers-reach/r32-c5-nvs-pending-chase-r1.ndjson"],
  ["c5-race", "C5", "ledgers-reach/r32-c5-nvs-pending-race-r1.ndjson"],
  ["c6-chase", "C6", "ledgers-reach/r32-c6-nvs-hung-chase-r1.ndjson"],
  ["c6-race", "C6", "ledgers-reach/r32-c6-nvs-hung-race-r1.ndjson"],
  ["e0-chase", "E0", "ledgers-reach/r32-e0-locki-nohold-chase-r1.ndjson"],
  ["e0-race-overlap", "E0", "ledgers-reach/r32-e0-locki-nohold-race-r1.ndjson"],
  ["e1-chase", "E1", "ledgers-reach/r32-e1-locki-hold3s-d0-chase-r1.ndjson"],
  ["e1-race", "E1", "ledgers-reach/r32-e1-locki-hold3s-d0-race-r1.ndjson"],
];
const API = [
  ["reload-fault-init", "B", "ledgers/s32-reload-init-r1.ndjson"],
  ["reload-fault-send", "B", "ledgers/s32-reload-send-r1.ndjson"],
  ["reload-control", "B", "ledgers/s32-reload-ctl-r1.ndjson"],
  ["warmup-chrome", "D", "ledgers/s32-con-initwarmup-r1.ndjson"],
  ["warmup-edge", "D", "ledgers/s32-edge-initwarmup-r1.ndjson"],
];

function read(rel) {
  const text = readFileSync(join(root, rel), "utf8");
  return {
    sha256: createHash("sha256").update(text).digest("hex"),
    events: text.trim().split("\n").map((l) => JSON.parse(l)),
  };
}

function page([name, group, rel]) {
  const { sha256, events } = read(rel);
  const ops = [];
  const instances = new Set();
  let overlapSeen = false;
  let truncated = null;
  for (const e of events) {
    let op = null;
    if (e.type === "handler.upload" || e.type === "handler.racePipelineHandleStartClick") op = ["start"];
    else if (e.type === "file-change") op = ["newVideo"];
    else if (e.type === "video.ended") op = ["ended"];
    else if (e.type === "send-call") {
      instances.add(e.inst);
      if (e.inflightAtCall >= 2) overlapSeen = true;
      op = ["dispatch", e.sid];
    } else if (e.type === "callback-enter") op = ["callback"];
    else if (e.type === "send-resolved") op = ["settle", e.sid, "resolved"];
    else if (e.type === "send-rejected") op = ["settle", e.sid, "rejected"];
    if (!op) continue;
    if (overlapSeen && op[0] === "settle") {
      truncated = { beforeLedgerEvent: e.ev, why: "first settlement after an overlapping send; later engine behaviour was caused by the overlap" };
      break;
    }
    ops.push(op);
  }
  if (instances.size > 1) throw new Error(`${rel}: sends on more than one instance`);
  return {
    name, group, kind: "page", page: rel.includes("-race-") ? "race" : "chase",
    source: { stage: "3.2", ledger: rel.split("/").pop(), sha256 },
    engineReadyBeforeReplay: true,
    truncated,
    phases: [ops],
  };
}

function api([name, group, rel]) {
  const { sha256, events } = read(rel);
  const phases = [];
  let ops = null;
  let warmedInPhase = false;
  let startedInPhase = false;
  const excluded = new Set();
  // A document starts at each page-load; ledgers without page-load events
  // (single-document runs) start at the harness's own "start" event.
  const hasPageLoad = events.some((e) => e.type === "page-load");
  for (const e of events) {
    if (hasPageLoad ? e.type === "page-load" : (ops === null && e.type === "start")) {
      ops = [];
      phases.push(ops);
      warmedInPhase = false;
      startedInPhase = false;
      continue;
    }
    if (ops === null) continue;
    // Only instance 1 of each document: later instances in the same page are
    // engine recreation, which this lifecycle does not model.
    if ((e.type === "send-call" || e.type === "send-resolved" || e.type === "send-rejected") && e.inst !== 1) { excluded.add(e.seq); continue; }
    if (e.type === "cb-enter" && e.inst !== 1) continue;
    if (e.type === "reload-request") { ops.push(["reload"]); continue; }
    if (e.type === "send-call") {
      if (!warmedInPhase) { ops.push(["warmup", e.seq]); warmedInPhase = true; continue; }
      if (!startedInPhase) { ops.push(["start"]); startedInPhase = true; }
      ops.push(["dispatch", e.seq]);
    } else if (e.type === "cb-enter") ops.push(["callback"]);
    else if (e.type === "send-resolved") ops.push(["settle", e.seq, "resolved"]);
    else if (e.type === "send-rejected") ops.push(["settle", e.seq, "rejected"]);
  }
  return {
    name, group, kind: "api", page: null,
    source: { stage: "3.2", ledger: rel.split("/").pop(), sha256 },
    engineReadyBeforeReplay: false,
    notes: [
      "The first send on instance 1 in each document is the dedicated warm-up.",
      "[\"start\"] is inserted before the first frame send: the API harness has no analysis session.",
      ...(excluded.size ? [`Sends on a recreated instance in the same page were excluded (ledger send ids ${[...excluded].join(", ")}).`] : []),
    ],
    truncated: null,
    phases,
  };
}

for (const spec of PAGE) {
  const f = page(spec);
  writeFileSync(join(OUT, `stage3-2-${f.name}.json`), JSON.stringify(f) + "\n");
}
for (const spec of API) {
  const f = api(spec);
  writeFileSync(join(OUT, `stage3-2-${f.name}.json`), JSON.stringify(f) + "\n");
}
console.log(`wrote ${PAGE.length + API.length} fixtures to ${OUT}`);
