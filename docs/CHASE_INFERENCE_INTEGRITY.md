# Chase inference-result integrity: design gate and state machine

**Status:** ported to `chase/inference-integrity-main`, based on `origin/main` at `7a13b69` (2026-11-16). Decision INT-1 is appended to `docs/DECISIONS.md`; it does not renumber or replace D1–D15. Scripted Node tests and a Playwright spec are included; the spec uses a scripted MediaPipe stand-in, and real-MediaPipe / real-video validation has not been performed.

**Scope:** the shared Chase analyzer path in `index.html` (`chaseDispatchPoseInference`, `onChasePoseResults`, `upload`, `stopChaseAnalysis`, `finishChaseAnalysis`) and the new pure module `src/chase-engine/inference-integrity.js`. One policy for every stroke selection. It changes no detector, threshold, cycle definition, sampling cadence, coaching rule or stroke capability. Backstroke, butterfly and breaststroke stay research-only.

**Not in scope:** the Race pipeline (a separate MediaPipe instance), the Phase 5C coverage observer, any MediaPipe API migration, and the result-time `video.currentTime` stamp on `metricsHistory.timestamps` (kept exactly as before; see §6).

## 1. Verified starting point (original audit baseline)

The findings below were verified against the pre-integrity analyzer in the source checkout before this port. The implementation is now based on `origin/main` at `7a13b69`; line references in the original audit table are historical and are not current `main` line numbers. The port preserves the same analyzer lifecycle points after checking their corresponding paths on `main`.

| # | Audit finding | Verified | Where (pre-change `index.html`) |
|---|---|---|---|
| F1 | One `pose.send()` path and one `onResults` callback for every stroke selection | Yes. The stroke value is read only at `upload()` validation and in the report | 1921, 2004, 2136, 2842, 2935 |
| F2 | `chaseAnalysisBusy` blocks overlap within a run; `stopChaseAnalysis()` clears it while a send may be unsettled | Yes | 1983, 2014, 2071, 2262, 2295 |
| F3 | `chasePendingFrameTiming` is one shared slot, written before each send, read by every result, never consumed | Yes. The comment at 1628–1630 says "consumed once"; the code never clears it after a read | 1642, 2002, 2166, 2350 |
| F4 | A late or duplicate callback can read a newer dispatch's record | Yes, by construction | 2002, 2350 |
| F5 | Results after a restart reach the newly reset histories | Yes. The pose-found branch has no `analyzing` or generation check; the generation check in `chaseSelectFrameTimestamp` protects only the PoseFrame timestamp, and only until the new session's first dispatch | 2148–2166, 2195, 2370–2400, 2533–2543 |
| F6 | Freestyle metrics are stamped with `video.currentTime` at result arrival | Yes | 2543, 2561 |
| F7 | No verified request ID in the legacy callback | Yes. `onResults(results)` carries landmarks and an image; synthetic evidence showed the image and landmarks can disagree under overlap (synthetic MediaPipe trials from earlier research, not included in this repository) | 1921 |
| F8 | The upload canvas resize can touch the canvas while an old send is unsettled | Yes. `prepareChaseAnalysisCanvas()` runs in `upload()` after `stopChaseAnalysis()` | 2190 |
| F9 | Late results after `finishChaseAnalysis()` keep mutating the histories | Yes | 2365–2573 |

Correction to the prior audit: none of substance. One precision: F5's cross-session leak through `chaseSelectFrameTimestamp` needs the old result to arrive **after** the new session's first dispatch; before it, the PoseFrame gets the fallback `currentTime` and `isFrameAccurate: false`, but the landmarks still enter the new session's histories.

## 2. The state machine

There is one **inference window** per `pose.send()` call. It opens immediately before `pose.send()` is called and closes when that call's promise settles. Page-wide state:

- `open`: the single open window, or none;
- `latched`: none, or the first integrity violation detected on this page (permanent until reload);
- counters.

A window records its session generation, the dispatch-time timing record of the send it was opened for, the number of callbacks observed while it was open, and the snapshot of the **first** such callback. A callback observed during a window is not known to have originated from that window's send.

| Event | Condition | Action |
|---|---|---|
| **Dispatch request** | `open` is set, or `latched` | Refused. No draw, no send. |
| | otherwise | Draw the frame, open a window, call `pose.send()`. |
| **Callback** | no window open | Drop. Violation `CALLBACK_WITHOUT_OPEN_SEND`; latch. |
| | window open, first callback | Hold a snapshot: landmark copies and `video.currentTime` read now. Nothing is committed yet. |
| | window open, second or later callback | Drop all held data. Violation `MULTIPLE_CALLBACKS_FOR_SEND`; latch. |
| **Settle: resolved** | latched | Discard held data. |
| | exactly one callback, window's session is current and active | **Commit** the snapshot, stamped with that send's dispatch-time record. The callback's origin is not known (§4). |
| | exactly one callback, session ended or replaced | Discard (`resultsDiscardedStale`). Not a violation. |
| | zero callbacks | Violation `RESOLVED_WITHOUT_CALLBACK`; latch. |
| **Settle: rejected** | zero callbacks | Nothing to commit (`sendsRejectedWithoutResult`). Not a violation. |
| | one or more callbacks | Discard. Violation `CALLBACK_FOR_REJECTED_SEND`; latch. |

Consequences built on the table:

- **No overlap, page-wide.** Because a dispatch is refused while any window is open, from any session, two sends are never outstanding at once. `stopChaseAnalysis()` no longer clears `chaseAnalysisBusy`; it clears when the window closes.
- **Canvas.** The analysis canvas is drawn or resized only inside a dispatch, and a dispatch happens only with no window open. `upload()` no longer resizes the canvas; it marks it for preparation at the next dispatch.
- **Latch.** A violation stops all further dispatches on the page. If a session is running, it is finished at once and its report is **withheld** (explicit message; `lastTrackedSequence` is `null`). `upload()` refuses with an explicit message until the page is reloaded. No timeout ever clears the latch or an open window.
- **Blocked start.** If a new session ends while a window from an earlier session is still open, it could not dispatch at all; the report says so explicitly instead of claiming the video had no usable pose.

## 3. The eight cases

"Committed" means it reaches `metricsHistory`, the PoseFrame history, the live overlay and, through them, the report.

1. **Result before `send()` settles.** It is the only callback observed during the window; it is held and committed at settlement, stamped with that send's dispatch-time record. Nothing establishes that it originated from that send (§4). Same values as before (both `currentTime` reads happen at callback time).
2. **Result after `send()` settles, before another dispatch.** The send settled with zero callbacks, so `RESOLVED_WITHOUT_CALLBACK` already latched at settlement. The late callback finds no open window: dropped, `CALLBACK_WITHOUT_OPEN_SEND`. Nothing committed; session withheld.
3. **Result from A after dispatch B has started.** B cannot start while A is open, so A's own result can arrive after B started only if it was not observed during A's window. If no callback at all was observed during A's window, A's settlement latched and B never started. If some other callback was observed alone during A's window, it was committed as A's: that is the undetected residual in §4, not a contained case.
4. **Duplicate after B has started.** The duplicate lands in B's window. If B's own result also arrives there, B has two callbacks: both dropped, latch, session withheld. If it lands after every window has closed, it is dropped and latches. If B's own result never arrives, or arrives only after the report, the duplicate is the only callback observed during B's window and **is committed as B's** (§4).
5. **Callback after a rejected send.** Inside the window: `CALLBACK_FOR_REJECTED_SEND` at settlement, discard, latch. After the window: `CALLBACK_WITHOUT_OPEN_SEND`, drop, latch.
6. **Callback during restart playback, after stop, or after video replacement.** The window still belongs to the old generation. Its callback is held and discarded at settlement (session replaced or inactive). Meanwhile no new dispatch, draw or canvas resize happens until that window closes. Nothing reaches the reset histories.
7. **A send that settles without a callback, or never settles.** Settles without: `RESOLVED_WITHOUT_CALLBACK`, latch, withheld. Never settles: the window stays open, so no further dispatch on the page; the current session keeps what it committed before; any later session reports that it was blocked by an unsettled inference and asks for a reload. No timeout.
8. **Reused-canvas mutation.** No draw or resize while any window is open (see §2).

## 4. Guarantees and limits

**What is guaranteed (from observable timing only, no identity assumption):** a callback is committed only if it was the only callback observed during the window of the single outstanding send, that send resolved, the session that dispatched it was still current and active when it settled, and no integrity violation had been detected on the page. It is stamped with that send's dispatch-time record, never with another dispatch's record. The system does **not** know that the callback originated from that send.

**Detected patterns fail closed; not every anomaly is detected.** Four observable patterns are always detected, counted and latched: a send that resolves with no callback observed; two or more callbacks observed during one window; a callback observed during a rejected send's window; and a callback observed with no send outstanding. A missing, late, duplicate, unsolicited or post-rejection callback is caught when it produces one of these patterns. It is **not** caught, and its result **is committed**, in the residual case below.

**What it cannot do — no request/result identity.** The legacy callback carries no verified request ID, so this design does **not** establish which input produced a result. One case is undetectable when it happens: a foreign callback (a duplicate or an unsolicited result) is the only callback observed during a send's window, because that send's own result is missing or delayed beyond the session's report. The foreign result is then committed as that frame's. Detecting it later (when the own result arrives late) latches and withholds every later session, but does not retract a report already shown. This residual needs two anomalies in the same window; neither was observed in earlier synthetic MediaPipe trials (that research is not included in this repository), which is evidence under tested conditions, not proof.

**Assumption about input reading:** the design assumes MediaPipe finishes reading the input canvas before the send's promise settles. A result computed from the input cannot precede reading it, but the legacy API documents no such contract. Not verified on real video.

**Availability cost (fail closed):**

- If real MediaPipe ever resolves a send without a callback, or calls back twice, analysis is withheld and disabled until reload. Synthetic serial trials showed exactly one callback per resolved send; real-video frequency is unknown.
- The result whose window is still open when the video ends is discarded (at most one sample per run). Before, it was kept only if its callback came before `ended`.
- Results arriving after a session ends no longer change the histories.
- The live skeleton overlay draws when a result is committed (at settlement), slightly later than at callback time.

## 5. Excluded instrumentation

The Phase 5C coverage observer is outside this port and is neither loaded nor required by the integrity implementation.

## 6. Left unchanged on purpose

- `metricsHistory.timestamps` and `window.lastMetrics.timestamp` still use `video.currentTime` read when the callback arrives (now captured in the snapshot and applied at commit, so the values are identical). Replacing them with the dispatch-time record would change freestyle cycle timing and needs its own decision and evidence.
- `chasePendingFrameTiming` is still written at each dispatch (existing e2e specs read it), but attribution no longer reads it.

## 7. Evidence still required

- Real-video validation runs: how often a send resolves without a callback, duplicates, post-rejection callbacks, and unsettled sends, under production options — these set the availability cost and the residual's likelihood.
- Real browser runs of the existing Playwright specs (not run here: `@playwright/test` is not installed in this worktree).
- A pixel/landmark/timestamp mismatch check (per-frame marker in the input) if identity is ever to be claimed.
