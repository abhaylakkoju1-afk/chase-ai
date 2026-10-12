// Unit tests for src/swimmer-tracking/continuity.js — the pure
// representative-position, velocity, projection, and continuity-error
// math (docs/SWIMMER_TRACKING_ARCHITECTURE.md §11).

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  computeRepresentativePosition,
  estimateVelocity,
  projectPosition,
  continuityError
} from "../../src/swimmer-tracking/continuity.js";

describe("computeRepresentativePosition() — centroid of hip + nose", () => {
  test("returns the midpoint of hip and nose, with visibility as the minimum of the two", () => {
    const result = computeRepresentativePosition({
      hip: { x: 0.4, y: 0.6, visibility: 0.9 },
      nose: { x: 0.6, y: 0.4, visibility: 0.7 }
    });

    assert.deepEqual(result, { x: 0.5, y: 0.5, visibility: 0.7 });
  });

  test("returns null when hip is missing", () => {
    const result = computeRepresentativePosition({ nose: { x: 0.5, y: 0.5, visibility: 0.9 } });
    assert.equal(result, null);
  });

  test("returns null when nose is missing", () => {
    const result = computeRepresentativePosition({ hip: { x: 0.5, y: 0.5, visibility: 0.9 } });
    assert.equal(result, null);
  });

  test("returns null when a landmark has a non-finite coordinate", () => {
    const result = computeRepresentativePosition({
      hip: { x: NaN, y: 0.5, visibility: 0.9 },
      nose: { x: 0.5, y: 0.5, visibility: 0.9 }
    });
    assert.equal(result, null);
  });

  test("returns null when landmarks is null", () => {
    assert.equal(computeRepresentativePosition(null), null);
  });
});

describe("estimateVelocity() — time-normalized, never a raw frame delta", () => {
  test("equivalent physical motion sampled at different intervals produces the same velocity", () => {
    // Scenario A: 0.10 units covered in 1000ms -> 0.10/s
    const velocityA = estimateVelocity({ x: 0.30, y: 0.5 }, 0, { x: 0.20, y: 0.5 }, 1000);
    // Scenario B: the SAME 0.10/s physical speed, sampled over a much
    // shorter 500ms window (0.05 units covered). A naive raw,
    // un-normalized delta would report 0.05 here and 0.10 in scenario A.
    const velocityB = estimateVelocity({ x: 0.30, y: 0.5 }, 0, { x: 0.25, y: 0.5 }, 500);

    assert.notEqual(velocityA, null);
    assert.notEqual(velocityB, null);
    assert.equal(velocityA.magnitudePerSecond, velocityB.magnitudePerSecond);
    assert.equal(Math.round(velocityA.magnitudePerSecond * 100) / 100, 0.10);

    // The raw, un-normalized deltas WOULD have differed (0.10 vs 0.05) —
    // confirming this is not a coincidental equality.
    assert.notEqual(Math.abs(0.20 - 0.30), Math.abs(0.25 - 0.30));
  });

  test("returns null for zero elapsed time (cannot divide by zero, no usable velocity)", () => {
    assert.equal(estimateVelocity({ x: 0.3, y: 0.5 }, 1000, { x: 0.4, y: 0.5 }, 1000), null);
  });

  test("returns null for negative elapsed time (out-of-order timestamps)", () => {
    assert.equal(estimateVelocity({ x: 0.3, y: 0.5 }, 1000, { x: 0.4, y: 0.5 }, 900), null);
  });

  test("magnitudePerSecond is the Euclidean norm of the x/y velocity components", () => {
    // 3-4-5 triangle scaled to a 1-second interval for an exact check.
    const result = estimateVelocity({ x: 0, y: 0 }, 0, { x: 0.3, y: 0.4 }, 1000);
    assert.equal(result.x, 0.3);
    assert.equal(result.y, 0.4);
    assert.equal(result.magnitudePerSecond, 0.5);
  });
});

describe("projectPosition() — simple linear projection", () => {
  test("projects forward using elapsed time and a constant velocity", () => {
    const result = projectPosition({ x: 0.5, y: 0.5 }, { x: 0.1, y: -0.05, magnitudePerSecond: 0.11 }, 2000);
    assert.equal(Math.round(result.x * 1000) / 1000, 0.7);
    assert.equal(Math.round(result.y * 1000) / 1000, 0.4);
  });

  test("zero elapsed time projects to the exact same position", () => {
    const result = projectPosition({ x: 0.5, y: 0.5 }, { x: 0.2, y: 0.2, magnitudePerSecond: 0.28 }, 0);
    assert.deepEqual(result, { x: 0.5, y: 0.5 });
  });

  test("returns null for negative elapsed time", () => {
    assert.equal(projectPosition({ x: 0.5, y: 0.5 }, { x: 0.1, y: 0, magnitudePerSecond: 0.1 }, -1), null);
  });

  test("projects correctly across a long reacquisition-style gap (several seconds)", () => {
    const result = projectPosition({ x: 0.2, y: 0.5 }, { x: 0.05, y: 0, magnitudePerSecond: 0.05 }, 5000);
    assert.equal(Math.round(result.x * 1000) / 1000, 0.45);
  });
});

describe("continuityError() — plain Euclidean distance, not x-only", () => {
  test("computes the straight-line distance between two positions", () => {
    // 3-4-5 triangle again, for an exact result.
    const error = continuityError({ x: 0, y: 0 }, { x: 0.3, y: 0.4 });
    assert.equal(error, 0.5);
  });

  test("is zero for identical positions", () => {
    assert.equal(continuityError({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), 0);
  });

  test("is symmetric (order of arguments does not matter)", () => {
    const a = { x: 0.2, y: 0.7 };
    const b = { x: 0.6, y: 0.3 };
    assert.equal(continuityError(a, b), continuityError(b, a));
  });

  test("a pure y-axis displacement is NOT ignored (not an x-only metric)", () => {
    const error = continuityError({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 });
    assert.ok(error > 0);
    assert.equal(Math.round(error * 100) / 100, 0.10);
  });
});
