// Unit tests for src/chronos-engine/time-basis.js — pure timestamp
// validation/normalization (docs/CHRONOS_ARCHITECTURE.md §14).
//
// This file's most important job is proving a negative: that Chronos
// never reads a clock of its own. A source-text scan alone would be easy
// to fool (a clock read hidden behind indirection would still pass a
// naive grep), so alongside a lightweight text check, this file also
// monkey-patches Date.now()/performance.now() to THROW for the duration
// of a real create -> arm -> start -> split -> finish sequence and
// asserts the sequence still completes successfully — the strongest
// available proof, under plain Node, that no code path in
// src/chronos-engine/* calls either of them.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  chronosValidateTimeSource,
  chronosResolveTimestamp
} from "../../src/chronos-engine/time-basis.js";

import { chronosCreateSession, chronosArmSession } from "../../src/chronos-engine/session.js";
import { chronosRecordEvent } from "../../src/chronos-engine/events.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHRONOS_ENGINE_DIR = join(__dirname, "..", "..", "src", "chronos-engine");
const CHRONOS_ENGINE_FILES = ["session.js", "time-basis.js", "events.js", "index.js"];

describe("chronosValidateTimeSource()", () => {
  test("accepts exactly \"video\", \"manual\", and \"wallclock\"", () => {
    assert.equal(chronosValidateTimeSource("video"), true);
    assert.equal(chronosValidateTimeSource("manual"), true);
    assert.equal(chronosValidateTimeSource("wallclock"), true);
  });

  test("rejects anything else, including near-miss strings and non-strings", () => {
    for (const value of ["Video", "webcam", "", null, undefined, 0, {}]) {
      assert.equal(chronosValidateTimeSource(value), false, `expected ${JSON.stringify(value)} to be invalid`);
    }
  });
});

describe("chronosResolveTimestamp() — valid timestamps", () => {
  for (const timeSource of ["video", "manual", "wallclock"]) {
    test(`accepts a plain finite atMs for timeSource "${timeSource}"`, () => {
      const result = chronosResolveTimestamp({ timeSource, atMs: 12345.5 });
      assert.equal(result.ok, true);
      assert.equal(result.atMs, 12345.5);
    });

    test(`accepts atMs === 0 for timeSource "${timeSource}" (boundary, not negative)`, () => {
      const result = chronosResolveTimestamp({ timeSource, atMs: 0 });
      assert.equal(result.ok, true);
      assert.equal(result.atMs, 0);
    });
  }
});

describe("chronosResolveTimestamp() — invalid timestamps", () => {
  const nonFiniteValues = [NaN, Infinity, -Infinity, "1500", null, undefined, {}, true];

  for (const value of nonFiniteValues) {
    test(`rejects a non-finite/non-number atMs (${JSON.stringify(value)}) as "timestamp-not-finite"`, () => {
      const result = chronosResolveTimestamp({ timeSource: "video", atMs: value });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "timestamp-not-finite");
      assert.equal(result.atMs, null);
    });
  }

  test("rejects a negative atMs as \"timestamp-negative\" per the architecture contract", () => {
    const result = chronosResolveTimestamp({ timeSource: "video", atMs: -0.001 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "timestamp-negative");
  });

  test("rejects an unknown timeSource as \"unknown-time-source\", checked before the timestamp itself", () => {
    const result = chronosResolveTimestamp({ timeSource: "webcam", atMs: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown-time-source");
  });
});

describe("video-media timestamps are caller-supplied, never generated internally", () => {
  test("chronosResolveTimestamp() returns exactly the atMs it was given, never a derived or rounded value", () => {
    const result = chronosResolveTimestamp({ timeSource: "video", atMs: 4321.987 });
    assert.equal(result.atMs, 4321.987);
  });

  test("the same numeric atMs is preserved end-to-end into a recorded TimingEvent", () => {
    const created = chronosCreateSession({
      sessionId: "time-basis-test",
      poolLengthMeters: 25,
      course: "Short Course",
      event: "Freestyle 50m",
      timeSource: "video"
    });
    const armed = chronosArmSession(created.session);
    const started = chronosRecordEvent(armed.session, {
      type: "start",
      atMs: 777.25,
      source: "manual"
    });

    assert.equal(started.ok, true);
    assert.equal(started.event.atMs, 777.25);
  });
});

describe("no browser clock is accessed — runtime proof", () => {
  test("a full create -> arm -> start -> split -> finish sequence completes with Date.now() and performance.now() both patched to throw", () => {
    const originalDateNow = Date.now;
    const originalPerformanceNow =
      typeof performance !== "undefined" ? performance.now : undefined;

    Date.now = () => {
      throw new Error("src/chronos-engine/* must never call Date.now()");
    };
    if (typeof performance !== "undefined") {
      performance.now = () => {
        throw new Error("src/chronos-engine/* must never call performance.now()");
      };
    }

    try {
      const created = chronosCreateSession({
        sessionId: "no-clock-access",
        poolLengthMeters: 25,
        course: "Short Course",
        event: "Freestyle 50m",
        timeSource: "video"
      });
      assert.equal(created.ok, true);

      const armed = chronosArmSession(created.session);
      assert.equal(armed.ok, true);

      const started = chronosRecordEvent(armed.session, { type: "start", atMs: 0, source: "manual" });
      assert.equal(started.ok, true);

      const split = chronosRecordEvent(started.session, {
        type: "split",
        atMs: 15000,
        distanceMeters: 25,
        source: "detector",
        detector: "turn-detector-v1",
        confidence: 0.8
      });
      assert.equal(split.ok, true);

      const finished = chronosRecordEvent(split.session, {
        type: "finish",
        atMs: 30000,
        distanceMeters: 50,
        source: "manual"
      });
      assert.equal(finished.ok, true);
      assert.equal(finished.session.finalTimeMs, 30000);
    } finally {
      Date.now = originalDateNow;
      if (typeof performance !== "undefined") {
        performance.now = originalPerformanceNow;
      }
    }
  });

  test("this Node test environment genuinely has no window/document/video globals to accidentally depend on", () => {
    assert.equal(typeof window, "undefined");
    assert.equal(typeof document, "undefined");
    assert.equal(typeof HTMLVideoElement, "undefined");
  });
});

describe("no browser clock is accessed — source-text guard (supplementary to the runtime proof above)", () => {
  // A plain-text scan is intentionally NOT the sole check here (see the
  // runtime proof above) — it exists only to catch an obvious literal
  // reintroduction of a forbidden call during a future edit. Matches are
  // checked against each line with any "//" comment stripped first, so a
  // line like "// never call Date.now()" does not itself trigger.
  const forbiddenPatterns = [
    "Date.now(",
    "performance.now(",
    "video.currentTime",
    "new Pose(",
    "localStorage.",
    "firebase"
  ];

  for (const file of CHRONOS_ENGINE_FILES) {
    test(`${file} contains no literal reference to a forbidden browser/clock API in executable code`, () => {
      const source = readFileSync(join(CHRONOS_ENGINE_DIR, file), "utf8");
      const codeOnlyLines = source
        .split("\n")
        .map((line) => {
          const commentIndex = line.indexOf("//");
          return commentIndex === -1 ? line : line.slice(0, commentIndex);
        });

      for (const pattern of forbiddenPatterns) {
        const offendingLine = codeOnlyLines.find((line) => line.includes(pattern));
        assert.equal(
          offendingLine,
          undefined,
          `${file} contains a non-comment reference to "${pattern}": ${JSON.stringify(offendingLine)}`
        );
      }
    });
  }
});
