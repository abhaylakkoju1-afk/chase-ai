// Unit tests for the Wall of Records' strict time parser (parsePBTime) and
// the best-time formatter used after an edit (formatPBTime), extracted from
// src/app/pages/pb.js. parsePBTime is the one check for every typed time,
// new or edited; it returns seconds or null.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { loadChaseFunctions } from "./extract-chase-functions.js";

const { parsePBTime, formatPBTime, normalizePBTime, displayPBTime, isValidPBSwim } = loadChaseFunctions();

describe("parsePBTime(text)", () => {
  const valid = [
    ["28.45", 28.45],
    ["1:05.32", 65.32],
    ["28", 28],
    ["28.4", 28.4],
    ["65", 65],
    ["65.32", 65.32],
    ["1:05", 65],
    ["0:28.45", 28.45],
    ["01:05.32", 65.32],
    ["15:30.12", 930.12],
    ["  1:05.32  ", 65.32],
    ["1:5.32", 65.32],            // one-digit seconds after the colon
    ["1:5", 65],
    ["2:0.5", 120.5],
    ["0:01", 1],
    ["1", 1],                     // the minimum: 1.00 second, any event
    ["1.00", 1],
    ["0:01.00", 1],
    ["120:00.00", 7200],          // no maximum
  ];
  for (const [text, seconds] of valid) {
    test(`accepts ${JSON.stringify(text)} as ${seconds} s`, () => {
      assert.strictEqual(parsePBTime(text), seconds);
    });
  }

  const invalid = [
    "-5", "-1:05.32", "+28.45",            // signs
    "0", "0.0", "0.00", "0:00", "0:00.00", // zero
    "0.01", "0.5", "0.99", "0:00.99",      // under the 1.00 s minimum
    "1:65.00", "99:99", "1:60", "1:60.5",  // seconds out of range after a colon
    "1:005.32", "1:123",                   // three-digit seconds after a colon
    "1:05:32", "1:02:03.00", "1:5:32",     // extra components
    "28.4x", "x28.4", "28 .4", "2 8",      // stray characters
    "28.456", "1:05.321", "1:5.321",       // more than two decimal places
    "28.", ".45", "1:", ":05", "1:05.",    // incomplete
    "28,45", "1;05.32",                    // other separators
    "abc", "", "   ", "1e3", "Infinity", "NaN", "0x1A",
  ];
  for (const text of invalid) {
    test(`rejects ${JSON.stringify(text)}`, () => {
      assert.strictEqual(parsePBTime(text), null);
    });
  }

  test("rejects non-string input safely", () => {
    for (const v of [null, undefined, NaN, -5, {}]) assert.strictEqual(parsePBTime(v), null);
  });

  test("is exact to the hundredth (no floating-point drift)", () => {
    assert.strictEqual(parsePBTime("0:58.07"), 58.07);
    assert.strictEqual(parsePBTime("1:10.10"), 70.1);
    assert.strictEqual(parsePBTime("4:59.99"), 299.99);
  });
});

describe("formatPBTime(seconds)", () => {
  test("under a minute: seconds with two decimals", () => {
    assert.strictEqual(formatPBTime(26.1), "26.10");
    assert.strictEqual(formatPBTime(25.5), "25.50");
    assert.strictEqual(formatPBTime(9.05), "9.05");
  });

  test("a minute or more: m:ss.hh", () => {
    assert.strictEqual(formatPBTime(65.32), "1:05.32");
    assert.strictEqual(formatPBTime(60), "1:00.00");
    assert.strictEqual(formatPBTime(930.12), "15:30.12");
  });

  test("round-trips through parsePBTime", () => {
    for (const s of [1, 9.05, 26.1, 59.99, 60, 65.32, 299.99, 930.12]) {
      assert.strictEqual(parsePBTime(formatPBTime(s)), s);
    }
  });
});

describe("normalizePBTime(text)", () => {
  test("pads a one-digit seconds part after the colon", () => {
    assert.strictEqual(normalizePBTime("1:5.32"), "1:05.32");
    assert.strictEqual(normalizePBTime("1:5"), "1:05");
    assert.strictEqual(normalizePBTime(" 12:0.5 "), "12:00.5");
  });

  test("otherwise keeps the time as typed, trimmed", () => {
    for (const [typed, saved] of [["28.45", "28.45"], ["1:05.32", "1:05.32"], ["31.4", "31.4"], [" 29.10 ", "29.10"], ["65", "65"], ["1.00", "1.00"]]) {
      assert.strictEqual(normalizePBTime(typed), saved);
    }
  });

  test("returns null for anything parsePBTime rejects", () => {
    for (const bad of ["0.99", "-5", "1:65.00", "1:5.321", "1:05:32", "28.4x", "", null]) {
      assert.strictEqual(normalizePBTime(bad), null);
    }
  });
});

describe("displayPBTime(text)", () => {
  test("shows a valid saved time in saved form", () => {
    assert.strictEqual(displayPBTime("1:5.32"), "1:05.32");
    assert.strictEqual(displayPBTime("2:9"), "2:09");
    assert.strictEqual(displayPBTime("28.4"), "28.4");
    assert.strictEqual(displayPBTime("1:05.32"), "1:05.32");
  });

  test("shows anything invalid exactly as saved, never hiding it", () => {
    for (const v of ["-5", "abc", "28.456", "1:65.00", "0.50", "", undefined, null]) {
      assert.strictEqual(displayPBTime(v), v);
    }
  });
});

describe("isValidPBSwim(seconds)", () => {
  test("accepts stored swims the parser would accept", () => {
    for (const s of [1, 28.45, 65.32, 299.99, 7200]) assert.strictEqual(isValidPBSwim(s), true);
  });

  test("rejects older stored values that aren't usable times", () => {
    for (const s of [null, undefined, NaN, Infinity, -5, 0, 0.5, 0.99, 28.456, "28.45"]) {
      assert.strictEqual(isValidPBSwim(s), false, String(s));
    }
  });
});
