// Unit tests for Chase's pure statistics helpers: averageValid and
// summariseMetric, the per-metric statistics helper used throughout the
// Chase analyzer and by stroke-cycle detection.
//
// Both now live in the standalone classic script src/chase-engine/stats.js
// (see the loading-order note at the top of that file for why it is a
// classic script, not an ES module). loadChaseFunctions() reads that file
// directly into its vm sandbox alongside its index.html extractions —
// chaseDetectFreestyleCycles (still inline in index.html) depends on
// summariseMetric, so the shared loader provides both here too rather
// than each test file loading stats.js independently.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";
import { normalizeVmValue } from "./normalize-vm-value.js";

const chase = loadChaseFunctions();

describe("averageValid(values)", () => {
  test("normal: mean of a valid numeric array", () => {
    assert.strictEqual(chase.averageValid([1, 2, 3]), 2);
  });

  test("boundary: empty array returns null", () => {
    assert.strictEqual(chase.averageValid([]), null);
  });

  test("invalid input: all-non-finite array returns null", () => {
    assert.strictEqual(chase.averageValid([NaN, Infinity, -Infinity]), null);
  });

  test("invalid input: non-finite values are ignored, not counted", () => {
    assert.strictEqual(chase.averageValid([1, NaN, 3, undefined]), 2);
  });
});

describe("summariseMetric(values)", () => {
  test("normal: known dataset matches hand-computed mean/stdDev", () => {
    // Classic textbook example: mean 5, population variance 4, stdDev 2.
    const result = chase.summariseMetric([2, 4, 4, 4, 5, 5, 7, 9]);
    assert.strictEqual(result.count, 8);
    assert.strictEqual(result.mean, 5);
    assert.ok(Math.abs(result.stdDev - 2) < 1e-9, `expected stdDev ~2, got ${result.stdDev}`);
    assert.strictEqual(result.min, 2);
    assert.strictEqual(result.max, 9);
  });

  test("boundary: a single value has zero standard deviation", () => {
    const result = chase.summariseMetric([5]);
    assert.deepStrictEqual(normalizeVmValue(result), { count: 1, mean: 5, stdDev: 0, min: 5, max: 5 });
  });

  test("boundary: an empty array returns the documented all-zero shape, not null or a throw", () => {
    const result = chase.summariseMetric([]);
    assert.deepStrictEqual(normalizeVmValue(result), { count: 0, mean: 0, stdDev: 0, min: 0, max: 0 });
  });

  test("invalid input: non-finite values are filtered out before computing stats", () => {
    const result = chase.summariseMetric([10, NaN, 20, Infinity, -Infinity, undefined]);
    assert.strictEqual(result.count, 2);
    assert.strictEqual(result.mean, 15);
    assert.strictEqual(result.min, 10);
    assert.strictEqual(result.max, 20);
  });

  test("invalid input: an array of only non-finite values behaves like an empty array", () => {
    const result = chase.summariseMetric([NaN, Infinity, undefined]);
    assert.deepStrictEqual(normalizeVmValue(result), { count: 0, mean: 0, stdDev: 0, min: 0, max: 0 });
  });
});
