// Unit tests for summariseMetric(), the per-metric statistics helper used
// throughout the Chase analyzer and by stroke-cycle detection.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";
import { normalizeVmValue } from "./normalize-vm-value.js";

const chase = loadChaseFunctions();

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
