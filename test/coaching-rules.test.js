// Unit tests for CHASE_COACHING_RULES, the fixed threshold-rule table
// behind Chase's evidence-bound coaching feedback (CLAUDE.md §6, §16).
//
// These tests pin down the CURRENT thresholds and wording exactly as
// they exist in index.html today. They intentionally do not change,
// "improve", or second-guess any threshold or message — the point is to
// make any future change to this table a visible, reviewed diff instead
// of a silent one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";
import { normalizeVmValue } from "./normalize-vm-value.js";

const chase = loadChaseFunctions();

function ruleFor(key) {
  const rule = chase.CHASE_COACHING_RULES.find((r) => r.key === key);
  assert.ok(rule, `expected a CHASE_COACHING_RULES entry with key "${key}"`);
  return rule;
}

describe("CHASE_COACHING_RULES — shape", () => {
  test("has exactly the 7 expected rules, in the current order", () => {
    const keys = chase.CHASE_COACHING_RULES.map((r) => r.key);
    assert.deepStrictEqual(normalizeVmValue(keys), [
      "elbow",
      "alignment",
      "rotation",
      "armSymmetry",
      "hipAlignment",
      "kneeAngle",
      "lateral",
    ]);
  });

  test("every rule returns null when its stats have no data (count === 0)", () => {
    for (const rule of chase.CHASE_COACHING_RULES) {
      assert.strictEqual(
        rule.evaluate({ count: 0, mean: 0, stdDev: 0 }),
        null,
        `rule "${rule.key}" should return null for count: 0`
      );
    }
  });
});

describe("elbow rule — threshold at stdDev > 25", () => {
  const rule = ruleFor("elbow");

  test("at the threshold (stdDev = 25) is reported consistent", () => {
    const result = rule.evaluate({ count: 5, mean: 30, stdDev: 25 });
    assert.strictEqual(result.observed, "Mean elbow angle 30.0°, variation ±25.0°.");
    assert.strictEqual(result.interpretation, "Elbow angle is relatively consistent across the analysed frames.");
    assert.strictEqual(result.recommendation, "This consistency is a reasonable baseline to maintain in training.");
  });

  test("just above the threshold (stdDev = 26) is reported inconsistent", () => {
    const result = rule.evaluate({ count: 5, mean: 30, stdDev: 26 });
    assert.strictEqual(result.observed, "Mean elbow angle 30.0°, variation ±26.0°.");
    assert.strictEqual(result.interpretation, "Elbow position varies considerably across the analysed frames.");
    assert.strictEqual(
      result.recommendation,
      "Review the catch and pull path with a coach — inconsistent elbow position can indicate variable propulsion between strokes."
    );
  });
});

describe("alignment rule — threshold at stdDev > 20", () => {
  const rule = ruleFor("alignment");

  test("at the threshold (stdDev = 20) is reported stable", () => {
    const result = rule.evaluate({ count: 5, mean: 10, stdDev: 20 });
    assert.strictEqual(result.observed, "Mean body-alignment angle 10.0°, variation ±20.0°.");
    assert.strictEqual(result.interpretation, "Body alignment is relatively stable across the clip.");
  });

  test("just above the threshold (stdDev = 20.1) is reported unstable", () => {
    const result = rule.evaluate({ count: 5, mean: 10, stdDev: 20.1 });
    assert.strictEqual(
      result.interpretation,
      "Body alignment (shoulder-hip-ankle line) changes noticeably during the clip."
    );
    assert.strictEqual(
      result.recommendation,
      "Focus on maintaining a stable trunk line; noticeable changes here often reflect a dropping hip or head position."
    );
  });
});

describe("rotation rule (Shoulder Asymmetry) — threshold at mean > 0.08", () => {
  const rule = ruleFor("rotation");

  test("at the threshold (mean = 0.08) is reported low", () => {
    const result = rule.evaluate({ count: 5, mean: 0.08, stdDev: 0 });
    assert.strictEqual(result.observed, "Mean shoulder height difference (normalised) 0.080.");
    assert.strictEqual(result.interpretation, "Shoulder height difference is relatively low on average.");
  });

  test("just above the threshold (mean = 0.081) is reported notable", () => {
    const result = rule.evaluate({ count: 5, mean: 0.081, stdDev: 0 });
    assert.strictEqual(result.observed, "Mean shoulder height difference (normalised) 0.081.");
    assert.strictEqual(result.interpretation, "The two shoulders show a noticeable vertical difference on average.");
  });
});

describe("armSymmetry rule — threshold at mean > 15", () => {
  const rule = ruleFor("armSymmetry");

  test("at the threshold (mean = 15) is reported similar", () => {
    const result = rule.evaluate({ count: 5, mean: 15, stdDev: 0 });
    assert.strictEqual(result.observed, "Mean left/right elbow-angle difference 15.0°.");
    assert.strictEqual(result.interpretation, "The two arms show a fairly similar average elbow angle.");
  });

  test("just above the threshold (mean = 15.1) is reported asymmetric", () => {
    const result = rule.evaluate({ count: 5, mean: 15.1, stdDev: 0 });
    assert.strictEqual(result.interpretation, "The two arms show a noticeable average difference in elbow angle.");
    assert.strictEqual(
      result.recommendation,
      "Compare footage of both arm strokes with a coach to check for a technical difference between sides, not just stroke-phase timing."
    );
  });
});

describe("hipAlignment rule — threshold at mean > 8", () => {
  const rule = ruleFor("hipAlignment");

  test("at the threshold (mean = 8) is reported close to horizontal", () => {
    const result = rule.evaluate({ count: 5, mean: 8, stdDev: 0 });
    assert.strictEqual(result.observed, "Mean hip-line tilt 8.0° from horizontal.");
    assert.strictEqual(result.interpretation, "The hip line is close to horizontal on average.");
  });

  test("just above the threshold (mean = 8.1) is reported tilted", () => {
    const result = rule.evaluate({ count: 5, mean: 8.1, stdDev: 0 });
    assert.strictEqual(result.interpretation, "The hip line is tilted from horizontal on average.");
    assert.strictEqual(
      result.recommendation,
      "Worth reviewing with a coach alongside body-alignment data, since a tilted hip line can accompany a dropped hip."
    );
  });
});

describe("kneeAngle rule — descriptive only, no threshold branch", () => {
  const rule = ruleFor("kneeAngle");

  test("always returns the same descriptive text when data is present", () => {
    const result = rule.evaluate({ count: 5, mean: 120, stdDev: 5 });
    assert.strictEqual(result.observed, "Mean knee angle 120.0°, averaged across the whole clip.");
    assert.strictEqual(result.interpretation, "This is a whole-clip average, not a peak flexion or extension value.");
    assert.strictEqual(
      result.recommendation,
      "Treat this figure as descriptive only; it is not yet a basis for kick-technique recommendations."
    );
  });
});

describe("lateral rule — threshold at stdDev > 0.05", () => {
  const rule = ruleFor("lateral");

  test("at the threshold (stdDev = 0.05) is reported steady", () => {
    const result = rule.evaluate({ count: 5, mean: 0, stdDev: 0.05 });
    assert.strictEqual(result.observed, "Lateral position variation (normalised) ±0.050.");
    assert.strictEqual(result.interpretation, "The swimmer's position in frame is fairly steady side-to-side.");
  });

  test("just above the threshold (stdDev = 0.051) is reported drifting", () => {
    const result = rule.evaluate({ count: 5, mean: 0, stdDev: 0.051 });
    assert.strictEqual(
      result.interpretation,
      "The swimmer's position in frame moves side-to-side more than a small amount during the clip."
    );
    assert.strictEqual(
      result.recommendation,
      "If the camera was fixed during filming, this may indicate the swimmer drifting off a straight line — worth reviewing the raw footage to confirm."
    );
  });
});
