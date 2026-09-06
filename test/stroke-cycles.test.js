// Unit tests for chaseDetectFreestyleCycles(), the freestyle stroke-cycle
// heuristic. This function takes no parameters — it reads a module-level
// `metricsHistory` object as a global. The extraction harness supplies
// `metricsHistory` as synthetic, deterministic fixture data (never real
// video/pose data, and never anything read from index.html), so each
// test below constructs its own wristMinY/timestamps/elbow arrays by
// hand and reassigns them before calling the function.
//
// Per CLAUDE.md's evidence-bound requirements, this heuristic is
// deterministic given its input, but it is a heuristic, not ground
// truth — these tests lock in its *current* behavior so future changes
// to it are visible, reviewed diffs, not silent regressions.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";
import { normalizeVmValue } from "./normalize-vm-value.js";

let chase;

beforeEach(() => {
  // Fresh sandbox per test — no state leaks between cases.
  chase = loadChaseFunctions();
});

describe("chaseDetectFreestyleCycles() — sample-count guard", () => {
  test("boundary: fewer than 8 samples returns no cycles", () => {
    chase.metricsHistory.wristMinY = [0.5, 0.4, 0.3, 0.4, 0.5];
    chase.metricsHistory.timestamps = [0, 100, 200, 300, 400];
    chase.metricsHistory.elbow = [140, 140, 140, 140, 140];

    assert.deepStrictEqual(normalizeVmValue(chase.chaseDetectFreestyleCycles()), []);
  });
});

describe("chaseDetectFreestyleCycles() — separated minima (normal case)", () => {
  test("two clearly separated minima produce exactly one detected cycle", () => {
    // 15 samples, 100ms apart, with two well-separated local minima in
    // wrist height at t=200 and t=800 (600ms apart, past the 300ms
    // refractory window). Elbow angle is held constant at 140 so the
    // per-cycle stats are trivial to hand-verify.
    chase.metricsHistory.timestamps =
      [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400];
    chase.metricsHistory.wristMinY =
      [0.5, 0.4, 0.3, 0.4, 0.5, 0.5, 0.5, 0.4, 0.3, 0.4, 0.5, 0.5, 0.5, 0.5, 0.5];
    chase.metricsHistory.elbow = new Array(15).fill(140);

    const cycles = chase.chaseDetectFreestyleCycles();

    assert.strictEqual(cycles.length, 1);
    assert.deepStrictEqual(normalizeVmValue(cycles[0]), {
      cycleNumber: 1,
      durationMs: 600,
      strokeRatePerMin: 100,
      elbowMean: 140,
      elbowStdDev: 0,
      sampleCount: 6,
    });
  });
});

describe("chaseDetectFreestyleCycles() — 300ms refractory behavior", () => {
  test("a candidate minimum inside the 300ms refractory window is suppressed", () => {
    // Minima candidates at t=100 and t=200 are only 100ms apart, inside
    // the refractory window, so the t=200 candidate must be dropped. A
    // third, real minimum at t=450 (350ms after the accepted t=100) is
    // far enough out to be accepted. If suppression works, exactly one
    // cycle spanning t=100..450 (not t=100..200 or t=200..450) results.
    chase.metricsHistory.timestamps = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550];
    chase.metricsHistory.wristMinY =
      [0.5, 0.4, 0.3, 0.4, 0.3, 0.5, 0.5, 0.5, 0.5, 0.3, 0.5, 0.5];
    chase.metricsHistory.elbow = new Array(12).fill(140);

    const cycles = chase.chaseDetectFreestyleCycles();

    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(cycles[0].durationMs, 350);
    assert.ok(
      Math.abs(cycles[0].strokeRatePerMin - (60000 / 350)) < 1e-9,
      `expected strokeRatePerMin ~${60000 / 350}, got ${cycles[0].strokeRatePerMin}`
    );
  });
});

describe("chaseDetectFreestyleCycles() — fewer than 2 minima", () => {
  test("boundary: only one detectable minimum yields no cycles", () => {
    // A single dip in the middle of the window, nothing else — there is
    // no second minimum to close a cycle against.
    chase.metricsHistory.timestamps = [0, 100, 200, 300, 400, 500, 600, 700];
    chase.metricsHistory.wristMinY = [0.5, 0.5, 0.5, 0.3, 0.5, 0.5, 0.5, 0.5];
    chase.metricsHistory.elbow = new Array(8).fill(140);

    assert.deepStrictEqual(normalizeVmValue(chase.chaseDetectFreestyleCycles()), []);
  });
});

describe("chaseDetectFreestyleCycles() — missing/invalid elbow data", () => {
  test("a detected cycle with no finite elbow samples reports null stats, not NaN", () => {
    chase.metricsHistory.timestamps =
      [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400];
    chase.metricsHistory.wristMinY =
      [0.5, 0.4, 0.3, 0.4, 0.5, 0.5, 0.5, 0.4, 0.3, 0.4, 0.5, 0.5, 0.5, 0.5, 0.5];
    // Every elbow sample is non-finite — cycle detection (driven by
    // wrist height) must still succeed independently of elbow data.
    chase.metricsHistory.elbow = new Array(15).fill(NaN);

    const cycles = chase.chaseDetectFreestyleCycles();

    assert.strictEqual(cycles.length, 1);
    assert.strictEqual(cycles[0].durationMs, 600);
    assert.strictEqual(cycles[0].elbowMean, null);
    assert.strictEqual(cycles[0].elbowStdDev, null);
    assert.strictEqual(cycles[0].sampleCount, 0);
  });
});
