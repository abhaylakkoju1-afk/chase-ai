// Scripted tests of the REAL index.html analyzer script for the eight
// inference-integrity cases in docs/CHASE_INFERENCE_INTEGRITY.md §3.
// Assertions are on what reaches the analysis data (metricsHistory, the
// PoseFrame history, currentAnalysis, lastTrackedSequence) and on the
// analysis state and output, not on callback order.
//
// MediaPipe is a scripted stand-in (test/inference-integrity-harness.js):
// these tests show what the analyzer does for each ordering; they are
// not evidence about which orderings real MediaPipe produces.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  PRE_INTEGRITY_INDEX_BLOB, createAnalyzer, currentIndexHtml, preIntegrityIndexHtml, poseResult, noPoseResult,
} from "./inference-integrity-harness.js";

const lengths = (s) => ({ metrics: s.metrics.timestamps.length, poseFrames: s.poseFrames.length, frames: s.analysis.frames });
const EMPTY = { metrics: 0, poseFrames: 0, frames: 0 };

async function running(options) {
  const h = createAnalyzer(options);
  await h.upload();
  assert.equal(h.state().analyzing, true);
  return h;
}

// One clean frame: dispatch at `t`, callback, then settle.
async function cleanFrame(h, t, seed) {
  const i = h.sends.length;
  h.frame(t);
  assert.equal(h.sends.length, i + 1, `frame at ${t}s dispatched`);
  h.callback(poseResult(seed));
  await h.resolve(i);
}

describe("case 1: result before send() settles", () => {
  test("held until settlement, then committed once, stamped with that send's dispatch timing and the arrival-time metric stamp", async () => {
    const h = await running();
    h.frame(0.5);
    h.video.currentTime = 0.52;            // the callback arrives a little later in the video
    h.callback(poseResult(1));
    assert.deepEqual(lengths(h.state()), EMPTY, "nothing is committed before the send settles");
    h.video.currentTime = 0.56;            // settlement later still
    await h.resolve(0);
    const s = h.state();
    assert.deepEqual(lengths(s), { metrics: 1, poseFrames: 1, frames: 1 });
    assert.equal(s.metrics.timestamps[0], 520, "metric stamp is video time at callback arrival, as before");
    assert.equal(s.poseFrames[0].videoTimestampMs, 500, "PoseFrame carries this send's own rVFC mediaTime");
    assert.equal(s.integrity.counters.resultsCommitted, 1);
    assert.equal(s.integrity.latched, null);
  });
});

describe("case 2: result after send() settles, before another dispatch", () => {
  test("settling without a callback latches; the late result is dropped and the session is withheld", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.frame(0.13);
    await h.resolve(1);                    // settles with no callback
    h.callback(poseResult(2));             // ...which then arrives late
    const s = h.state();
    assert.deepEqual(lengths(s), { metrics: 1, poseFrames: 1, frames: 1 }, "the late result reached no history");
    assert.equal(s.analyzing, false);
    assert.equal(s.tracked, null);
    assert.equal(s.integrity.latched.violation, "RESOLVED_WITHOUT_CALLBACK");
    assert.match(h.feedback(), /Analysis Withheld/);
    assert.doesNotMatch(h.feedback(), /Elbow|Stroke Cycles/);
    assert.equal(h.elements.metrics.innerHTML, "", "live metrics from the withheld session are cleared");
  });
});

describe("case 3: result from A after dispatch B has started", () => {
  test("B cannot start while A is outstanding; if A settles empty, B never starts and A's late result is dropped", async () => {
    const h = await running();
    h.frame(0);
    h.frame(0.13);
    h.frame(0.26);
    assert.equal(h.sends.length, 1, "no second send while the first is outstanding");
    await h.resolve(0);                    // A resolves with no callback
    h.frame(0.39);
    assert.equal(h.sends.length, 1, "after the latch no further send is made");
    h.callback(poseResult(1));             // A's result, late
    assert.deepEqual(lengths(h.state()), EMPTY);
    assert.equal(h.state().integrity.latched.violation, "RESOLVED_WITHOUT_CALLBACK");
  });
});

describe("case 4: duplicate callback after B has started", () => {
  test("a duplicate plus B's own result in B's window: both dropped, latched, session withheld", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.frame(0.13);
    h.callback(poseResult(1));             // duplicate of A
    h.callback(poseResult(2));             // B's own
    assert.equal(h.state().integrity.latched.violation, "MULTIPLE_CALLBACKS_FOR_SEND");
    await h.resolve(1);
    const s = h.state();
    assert.deepEqual(lengths(s), { metrics: 1, poseFrames: 1, frames: 1 }, "only A, committed before the anomaly");
    assert.equal(s.tracked, null);
    assert.match(h.feedback(), /Analysis Withheld/);
  });

  test("a duplicate after every send has settled is dropped and latches", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.callback(poseResult(1));
    assert.deepEqual(lengths(h.state()), { metrics: 1, poseFrames: 1, frames: 1 });
    assert.equal(h.state().integrity.latched.violation, "CALLBACK_WITHOUT_OPEN_SEND");
  });

  test("documented residual: a duplicate alone in B's window, with B's own result never delivered, is committed as B's", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.frame(0.13);
    h.callback(poseResult(1));             // duplicate of A; B's own never arrives
    await h.resolve(1);
    const s = h.state();
    assert.equal(s.metrics.timestamps.length, 2, "undetectable without request identity");
    assert.equal(s.integrity.latched, null);
    // If B's own result arrives later, the anomaly is caught from then on.
    h.callback(poseResult(2));
    assert.equal(h.state().integrity.latched.violation, "CALLBACK_WITHOUT_OPEN_SEND");
    assert.match(h.feedback(), /Analysis Withheld/, "the session still running is withheld");
  });
});

describe("case 5: callback after a rejected send", () => {
  test("a rejection with no callback is clean and analysis continues", async () => {
    const h = await running();
    h.frame(0);
    await h.reject(0);
    await cleanFrame(h, 0.13, 2);
    const s = h.state();
    assert.equal(s.integrity.latched, null);
    assert.equal(s.integrity.counters.sendsRejectedWithoutResult, 1);
    assert.deepEqual(lengths(s), { metrics: 1, poseFrames: 1, frames: 1 });
  });

  test("a callback inside a send that then rejects: nothing committed, latched", async () => {
    const h = await running();
    h.frame(0);
    h.callback(poseResult(1));
    await h.reject(0);
    assert.deepEqual(lengths(h.state()), EMPTY);
    assert.equal(h.state().integrity.latched.violation, "CALLBACK_FOR_REJECTED_SEND");
  });

  test("a callback after a send has rejected: dropped, latched", async () => {
    const h = await running();
    h.frame(0);
    await h.reject(0);
    h.callback(poseResult(1));
    assert.deepEqual(lengths(h.state()), EMPTY);
    assert.equal(h.state().integrity.latched.violation, "CALLBACK_WITHOUT_OPEN_SEND");
  });
});

describe("case 6: callbacks across restart, stop and video replacement", () => {
  test("a result for the old session arriving during restart playback never reaches the new session", async () => {
    const h = await running();
    h.frame(0);                            // A outstanding in session 1
    const gate = h.holdPlayback();
    const restart = h.run("upload()");     // session 2: histories reset, waiting on play()
    await h.flush();
    h.callback(poseResult(9));             // A's result arrives during restart playback
    await h.resolve(0);
    gate.release();
    await restart;
    await h.flush();
    let s = h.state();
    assert.deepEqual(lengths(s), EMPTY, "the old result is discarded");
    assert.equal(s.integrity.counters.resultsDiscardedStale, 1);
    assert.equal(s.integrity.latched, null);
    await cleanFrame(h, 0, 2);
    s = h.state();
    assert.deepEqual(lengths(s), { metrics: 1, poseFrames: 1, frames: 1 });
    assert.equal(s.poseFrames[0].videoTimestampMs, 0);
  });

  test("a new session does not dispatch until the old send settles", async () => {
    const h = await running();
    h.frame(0);
    await h.upload();                      // restart while A is outstanding
    h.frame(0);
    h.frame(0.13);
    assert.equal(h.sends.length, 1, "no overlap with the old send");
    await h.resolve(0);                    // old A settles (no callback: violation)
    assert.equal(h.state().integrity.latched.violation, "RESOLVED_WITHOUT_CALLBACK");
  });

  test("after stop, a late result for the stopped session is discarded", async () => {
    const h = await running();
    h.frame(0);
    h.run("stopChaseAnalysis()");
    h.callback(poseResult(1));
    await h.resolve(0);
    const s = h.state();
    assert.deepEqual(lengths(s), EMPTY);
    assert.equal(s.integrity.counters.resultsDiscardedStale, 1);
    assert.equal(s.busy, false, "busy clears when the send settles, not at stop");
  });

  test("after video replacement, an outstanding result is discarded and the next analysis starts clean", async () => {
    const h = await running();
    h.fireDOMContentLoaded();
    h.frame(0);
    h.replaceVideo();
    assert.equal(h.state().busy, true, "replacement does not clear the outstanding send");
    h.callback(poseResult(1));
    await h.resolve(0);
    assert.deepEqual(lengths(h.state()), EMPTY);
    await h.upload();
    await cleanFrame(h, 0, 2);
    assert.deepEqual(lengths(h.state()), { metrics: 1, poseFrames: 1, frames: 1 });
  });

  test("results after finishChaseAnalysis() no longer change the histories", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.frame(0.13);
    h.finish();
    h.callback(poseResult(2));
    await h.resolve(1);
    const s = h.state();
    assert.deepEqual(lengths(s), { metrics: 1, poseFrames: 1, frames: 1 });
    assert.equal(s.tracked.frames.length, 1);
  });
});

describe("case 7: a send that settles without a callback, or never settles", () => {
  test("settles without a callback: latched, withheld, and a new upload is refused explicitly", async () => {
    const h = await running();
    h.frame(0);
    await h.resolve(0);
    assert.match(h.feedback(), /Analysis Withheld/);
    await h.upload();
    assert.equal(h.state().analyzing, false, "upload refused");
    assert.match(h.status(), /Analysis withheld because results couldn't be matched reliably to video frames\. Reload the page before trying again\./);
    h.frame(0);
    assert.equal(h.sends.length, 1);
  });

  test("never settles: no timeout, no later dispatch, and the blocked session says why", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.frame(0.13);                         // never settles
    h.callback(poseResult(2));             // held, never committed
    h.finish();
    assert.equal(h.state().tracked.frames.length, 1, "the session keeps only what committed");
    await h.upload();                      // a new session cannot dispatch
    h.frame(0);
    h.frame(0.13);
    assert.equal(h.sends.length, 2);
    h.finish();
    assert.match(h.feedback(), /couldn't start/);
    assert.match(h.status(), /Analysis couldn't start because a frame from an earlier analysis was still being processed\. Reload the page and try again\./);
    assert.doesNotMatch(h.feedback(), /could not obtain reliable body-tracking data/);
    assert.deepEqual(h.timeouts, [], "nothing is scheduled to clear the outstanding send");
  });
});

describe("case 8: the analysis canvas is never changed while a send may read it", () => {
  test("no draw or resize while any send is outstanding, across restart", async () => {
    const h = await running();
    await cleanFrame(h, 0, 1);
    h.frame(0.13);                         // outstanding
    h.video.videoWidth = 1280;             // a different video size for the next session
    await h.upload();
    h.frame(0);                            // refused: old send outstanding
    h.callback(poseResult(2));             // old send's result: held, then discarded as stale
    await h.resolve(1);
    assert.equal(h.state().integrity.latched, null);
    h.frame(0.05);
    h.callback(poseResult(3));
    await h.resolve(2);
    const touches = h.events.filter((e) => e.type === "draw" || e.type === "resize");
    assert.ok(touches.length > 0);
    assert.deepEqual(touches.filter((e) => e.outstanding), [], JSON.stringify(h.events));
  });
});

describe("no per-stroke behaviour and freestyle preservation", () => {
  async function scriptedRun(options) {
    const h = createAnalyzer(options);
    await h.upload();
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    for (let i = 0; i < seeds.length; i++) {
      const t = i * 0.13;
      h.frame(t);
      h.video.currentTime = t + 0.02;
      h.callback(i === 4 ? noPoseResult() : poseResult(seeds[i]));
      h.video.currentTime = t + 0.04;
      await h.resolve(h.sends.length - 1);
    }
    h.finish();
    return h;
  }

  const comparable = (s) => ({ metrics: s.metrics, poseFrames: s.poseFrames, analysis: { frames: s.analysis.frames, validFrames: s.analysis.validFrames }, trackedFrames: s.tracked && s.tracked.frames });

  test("all four stroke selections go through the same path and produce identical data", async () => {
    const results = {};
    for (const stroke of ["freestyle", "backstroke", "butterfly", "breaststroke"]) results[stroke] = comparable((await scriptedRun({ stroke })).state());
    for (const stroke of ["backstroke", "butterfly", "breaststroke"]) assert.deepEqual(results[stroke], results.freestyle, stroke);
    assert.equal(results.freestyle.metrics.timestamps.length, 9);
  });

  test("the three research strokes stay unsupported in the analyzer", () => {
    const block = currentIndexHtml().match(/const CHASE_STROKE_SUPPORT = \{[\s\S]*?\};/)[0];
    assert.match(block, /freestyle:\s*\{ supported: true/);
    for (const stroke of ["backstroke", "breaststroke", "butterfly"]) assert.match(block, new RegExp(`${stroke}:\\s*\\{ supported: false`));
  });

  // The baseline is read from Git (CI checks out full history for it).
  // Locally a checkout without it skips with a reason; in CI it fails,
  // so the comparison can never be skipped silently there.
  function baselineOrSkip(t) {
    const html = preIntegrityIndexHtml();
    if (html) return html;
    if (process.env.CI) assert.fail(`pre-integrity index.html blob ${PRE_INTEGRITY_INDEX_BLOB} is not in this checkout; CI needs full history (fetch-depth: 0)`);
    t.skip("pre-integrity index.html blob not available from Git");
    return null;
  }

  test("on clean serial input, histories and the report equal the pre-integrity analyzer's", async (t) => {
    const oldHtml = baselineOrSkip(t);
    if (!oldHtml) return;
    for (const stroke of ["freestyle", "backstroke"]) {
      const before = await scriptedRun({ html: oldHtml, stroke });
      const after = await scriptedRun({ stroke });
      assert.deepEqual(comparable(after.state()), comparable(before.state()), stroke);
      assert.equal(after.feedback(), before.feedback(), `${stroke} report HTML`);
      assert.equal(after.status(), before.status());
    }
  });

  test("the pre-integrity analyzer let an old session's result into a restarted session (the defect fixed here)", async (t) => {
    const oldHtml = baselineOrSkip(t);
    if (!oldHtml) return;
    const h = createAnalyzer({ html: oldHtml });
    await h.upload();
    h.frame(0);
    const gate = h.holdPlayback();
    const restart = h.run("upload()");
    await h.flush();
    h.callback(poseResult(9));
    await h.resolve(0);
    gate.release();
    await restart;
    assert.equal(h.state().metrics.timestamps.length, 1, "old code: stale result entered the new session");
  });
});

