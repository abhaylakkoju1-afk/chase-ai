// Unit tests for the small time/string helpers used by the personal-best
// tracker and stroke-score calculation: timeToSeconds, formatTime,
// capitalize.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";

const chase = loadChaseFunctions();

describe("timeToSeconds(t)", () => {
  test("normal: a bare seconds string", () => {
    assert.strictEqual(chase.timeToSeconds("28.4"), 28.4);
  });

  test("normal: mm:ss.ss format", () => {
    assert.strictEqual(chase.timeToSeconds("1:05.32"), 65.32);
  });

  test("boundary: zero", () => {
    assert.strictEqual(chase.timeToSeconds("0:00.00"), 0);
  });

  test(
    "known current limitation: an h:mm:ss string silently drops the third segment " +
      "(this documents existing behavior, per CLAUDE.md §17 — it is not being fixed here)",
    () => {
      // "1:02:03".split(":") -> ["1", "02", "03"]; only p[0] and p[1] are
      // ever read, so this evaluates to 1*60 + 2 = 62, not the "correct"
      // 3723 seconds a hh:mm:ss reading would imply.
      assert.strictEqual(chase.timeToSeconds("1:02:03"), 62);
    }
  );
});

describe("formatTime(seconds)", () => {
  test("normal: sub-minute value pads to two digits before the decimal", () => {
    assert.strictEqual(chase.formatTime(5), "0:05.00");
  });

  test("normal: round-trips a mm:ss.ss value produced by timeToSeconds", () => {
    assert.strictEqual(chase.formatTime(65.32), "1:05.32");
  });

  test("boundary: exactly one minute rolls over cleanly", () => {
    assert.strictEqual(chase.formatTime(60), "1:00.00");
  });
});

describe("capitalize(s)", () => {
  test("normal: capitalizes the first letter of a lowercase word", () => {
    assert.strictEqual(chase.capitalize("freestyle"), "Freestyle");
  });

  test("boundary: an already-capitalized single letter is unchanged", () => {
    assert.strictEqual(chase.capitalize("A"), "A");
  });

  test("boundary: an empty string returns an empty string, not a throw", () => {
    assert.strictEqual(chase.capitalize(""), "");
  });
});
