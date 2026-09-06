// Unit tests for Chase's pure geometry helpers. These functions are the
// foundation every biomechanical angle/alignment metric is built on.
//
// midpoint, chaseCalculateAngle, calculateLineAngle, and isVisible now
// live in the standalone classic script src/chase-engine/geometry.js
// (see the loading-order note at the top of that file for why it is a
// classic script, not an ES module). They are loaded below via
// loadGeometryHelpers(), a smaller version of the same vm-sandbox
// technique extract-chase-functions.js uses — simpler here because the
// whole small file IS the declarations, with no anchor search or
// balanced-block scanning needed.
//
// averageValid's tests moved to metrics.test.js, alongside
// summariseMetric — both now live in src/chase-engine/stats.js.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { normalizeVmValue } from "./normalize-vm-value.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEOMETRY_MODULE_PATH = join(__dirname, "..", "src", "chase-engine", "geometry.js");
const GEOMETRY_HELPER_NAMES = ["midpoint", "chaseCalculateAngle", "calculateLineAngle", "isVisible"];

function loadGeometryHelpers() {
  const source = readFileSync(GEOMETRY_MODULE_PATH, "utf8");
  const sandbox = {};
  vm.createContext(sandbox);

  try {
    vm.runInContext(source, sandbox, { filename: "chase-engine-geometry.vm.js" });
  } catch (error) {
    throw new Error(
      `Failed to evaluate src/chase-engine/geometry.js in an isolated vm sandbox: ${error.message}`
    );
  }

  for (const name of GEOMETRY_HELPER_NAMES) {
    if (typeof sandbox[name] === "undefined") {
      throw new Error(
        `src/chase-engine/geometry.js loaded without error, but "${name}" is not present on ` +
        `the sandbox afterwards. This should not happen and likely indicates the file's ` +
        `contents no longer match GEOMETRY_HELPER_NAMES.`
      );
    }
  }

  return sandbox;
}

const geometry = loadGeometryHelpers();

describe("midpoint(a, b)", () => {
  test("normal: averages x/y/z of two points", () => {
    const result = geometry.midpoint({ x: 0, y: 0, z: 2 }, { x: 10, y: 20, z: 4 });
    assert.deepStrictEqual(normalizeVmValue(result), { x: 5, y: 10, z: 3 });
  });

  test("boundary: missing z on both points defaults to 0", () => {
    const result = geometry.midpoint({ x: 0, y: 0 }, { x: 10, y: 20 });
    assert.deepStrictEqual(normalizeVmValue(result), { x: 5, y: 10, z: 0 });
  });

  test("invalid input: null point a returns null", () => {
    assert.strictEqual(geometry.midpoint(null, { x: 1, y: 1 }), null);
  });

  test("invalid input: null point b returns null", () => {
    assert.strictEqual(geometry.midpoint({ x: 1, y: 1 }, null), null);
  });
});

describe("chaseCalculateAngle(a, b, c)", () => {
  test("normal: a clean 90-degree angle at the vertex", () => {
    const angle = geometry.chaseCalculateAngle(
      { x: 0, y: 1 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    assert.ok(Math.abs(angle - 90) < 1e-9, `expected ~90, got ${angle}`);
  });

  test("normal: a straight 180-degree line", () => {
    const angle = geometry.chaseCalculateAngle(
      { x: -1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    assert.ok(Math.abs(angle - 180) < 1e-9, `expected ~180, got ${angle}`);
  });

  test("normal: a folded-back 0-degree angle", () => {
    const angle = geometry.chaseCalculateAngle(
      { x: 1, y: 0 },
      { x: 0, y: 0 },
      { x: 1, y: 0 }
    );
    assert.ok(Math.abs(angle - 0) < 1e-9, `expected ~0, got ${angle}`);
  });

  test("boundary: zero-length vector (a coincides with vertex b) returns null", () => {
    assert.strictEqual(
      geometry.chaseCalculateAngle({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 }),
      null
    );
  });

  test("invalid input: missing landmark returns null instead of throwing", () => {
    assert.strictEqual(geometry.chaseCalculateAngle(null, { x: 0, y: 0 }, { x: 1, y: 0 }), null);
    assert.strictEqual(geometry.chaseCalculateAngle({ x: 0, y: 0 }, undefined, { x: 1, y: 0 }), null);
    assert.strictEqual(geometry.chaseCalculateAngle({ x: 0, y: 0 }, { x: 1, y: 0 }, null), null);
  });
});

describe("calculateLineAngle(a, b)", () => {
  test("normal: a horizontal line is 0 degrees", () => {
    assert.strictEqual(geometry.calculateLineAngle({ x: 0, y: 0 }, { x: 10, y: 0 }), 0);
  });

  test("normal: a vertical line is 90 degrees", () => {
    const angle = geometry.calculateLineAngle({ x: 0, y: 0 }, { x: 0, y: 10 });
    assert.ok(Math.abs(angle - 90) < 1e-9, `expected ~90, got ${angle}`);
  });

  test("boundary: a leftward horizontal line is 180 degrees (angle is unsigned)", () => {
    const angle = geometry.calculateLineAngle({ x: 0, y: 0 }, { x: -10, y: 0 });
    assert.ok(Math.abs(angle - 180) < 1e-9, `expected ~180, got ${angle}`);
  });

  test("invalid input: missing point returns null", () => {
    assert.strictEqual(geometry.calculateLineAngle(null, { x: 1, y: 1 }), null);
    assert.strictEqual(geometry.calculateLineAngle({ x: 1, y: 1 }, null), null);
  });
});

describe("isVisible(point, threshold = 0.35)", () => {
  test("normal: visibility clearly above the default threshold", () => {
    assert.strictEqual(geometry.isVisible({ visibility: 0.9 }), true);
  });

  test("normal: visibility clearly below the default threshold", () => {
    assert.strictEqual(geometry.isVisible({ visibility: 0.1 }), false);
  });

  test("boundary: visibility exactly at the threshold counts as visible", () => {
    assert.strictEqual(geometry.isVisible({ visibility: 0.35 }), true);
  });

  test("invalid input: missing visibility field defaults to fully visible", () => {
    assert.strictEqual(geometry.isVisible({}), true);
  });

  test("invalid input: null point is not visible", () => {
    assert.strictEqual(geometry.isVisible(null), false);
  });
});
