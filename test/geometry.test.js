// Unit tests for Chase's pure geometry helpers, extracted directly from
// index.html by test/extract-chase-functions.js. These functions are the
// foundation every biomechanical angle/alignment metric is built on.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";
import { normalizeVmValue } from "./normalize-vm-value.js";

const chase = loadChaseFunctions();

describe("midpoint(a, b)", () => {
  test("normal: averages x/y/z of two points", () => {
    const result = chase.midpoint({ x: 0, y: 0, z: 2 }, { x: 10, y: 20, z: 4 });
    assert.deepStrictEqual(normalizeVmValue(result), { x: 5, y: 10, z: 3 });
  });

  test("boundary: missing z on both points defaults to 0", () => {
    const result = chase.midpoint({ x: 0, y: 0 }, { x: 10, y: 20 });
    assert.deepStrictEqual(normalizeVmValue(result), { x: 5, y: 10, z: 0 });
  });

  test("invalid input: null point a returns null", () => {
    assert.strictEqual(chase.midpoint(null, { x: 1, y: 1 }), null);
  });

  test("invalid input: null point b returns null", () => {
    assert.strictEqual(chase.midpoint({ x: 1, y: 1 }, null), null);
  });
});

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

describe("chaseCalculateAngle(a, b, c)", () => {
  test("normal: a clean 90-degree angle at the vertex", () => {
    const angle = chase.chaseCalculateAngle(
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    assert.ok(Math.abs(angle - 90) < 1e-9, `expected ~90, got ${angle}`);
  });

  test("normal: a straight 180-degree line", () => {
    const angle = chase.chaseCalculateAngle(
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    assert.ok(Math.abs(angle - 180) < 1e-9, `expected ~180, got ${angle}`);
  });

  test("normal: a folded-back 0-degree angle", () => {
    const angle = chase.chaseCalculateAngle(
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    assert.ok(Math.abs(angle - 0) < 1e-9, `expected ~0, got ${angle}`);
  });

  test("boundary: zero-length vector (a coincides with vertex b) returns null", () => {
    assert.strictEqual(
      chase.chaseCalculateAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }),
      null
    );
  });

  test("invalid input: missing landmark returns null instead of throwing", () => {
    assert.strictEqual(chase.chaseCalculateAngle(null, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
    assert.strictEqual(chase.chaseCalculateAngle({ x: 0, y: 0 }, undefined, { x: 1, y: 0 }), null);
    assert.strictEqual(chase.chaseCalculateAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, null), null);
  });
});

describe("calculateLineAngle(a, b)", () => {
  test("normal: a horizontal line is 0 degrees", () => {
    assert.strictEqual(chase.calculateLineAngle({ x: 0, y: 0 }, { x: 10, y: 0 }), 0);
  });

  test("normal: a vertical line is 90 degrees", () => {
    const angle = chase.calculateLineAngle({ x: 0, y: 0 }, { x: 0, y: 10 });
    assert.ok(Math.abs(angle - 90) < 1e-9, `expected ~90, got ${angle}`);
  });

  test("boundary: a leftward horizontal line is 180 degrees (angle is unsigned)", () => {
    const angle = chase.calculateLineAngle({ x: 0, y: 0 }, { x: -10, y: 0 });
    assert.ok(Math.abs(angle - 180) < 1e-9, `expected ~180, got ${angle}`);
  });

  test("invalid input: missing point returns null", () => {
    assert.strictEqual(chase.calculateLineAngle(null, { x: 1, y: 1 }), null);
    assert.strictEqual(chase.calculateLineAngle({ x: 1, y: 1 }, null), null);
  });
});

describe("isVisible(point, threshold = 0.35)", () => {
  test("normal: visibility clearly above the default threshold", () => {
    assert.strictEqual(chase.isVisible({ visibility: 0.9 }), true);
  });

  test("normal: visibility clearly below the default threshold", () => {
    assert.strictEqual(chase.isVisible({ visibility: 0.1 }), false);
  });

  test("boundary: visibility exactly at the threshold counts as visible", () => {
    assert.strictEqual(chase.isVisible({ visibility: 0.35 }), true);
  });

  test("invalid input: missing visibility field defaults to fully visible", () => {
    assert.strictEqual(chase.isVisible({}), true);
  });

  test("invalid input: null point is not visible", () => {
    assert.strictEqual(chase.isVisible(null), false);
  });
});
