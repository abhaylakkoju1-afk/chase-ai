# SwimTics — Chase AI

**SwimTics** is a swimming performance project with tools for video analysis, race review, personal-best tracking, athlete profiles, and meet preparation. **Chase** is its swim-video analysis feature; **Chronos** is its race-analysis tool.

The project is moving toward evidence-based coaching: detect events and movement from video, measure what can be supported by the footage, and communicate uncertainty when the evidence is limited.

> **Read this first:** The live site presents several tools, but their capabilities and validation levels differ. This README distinguishes what the product currently offers from engineering prototypes and research work that are not yet integrated.

## Progress so far

SwimTics has a live site with a single-page interface for its main tools. The site currently presents video upload and analysis, personal-best tracking, race-video analysis, athlete profiles, and a readiness planner. The race-analysis interface includes controls for marking a pre-start frame and lane reference, starting or resetting analysis, and reviewing splits.

On the engineering side, work has advanced beyond the original single-file prototype:

- A **Pose inference lifecycle core and adapter** have been developed with tests for request ordering, session failures, and timestamp handling. The adapter remains unwired from the product pages.
- **PR #49** introduced a Chase inference-integrity change intended to fail closed when pose results cannot be attributed to a send. It was reported open and awaiting review; real MediaPipe and real-video validation remained outstanding.
- **PR #50** added a synthetic and scripted evaluation foundation for future stroke-specific analysis. Its detectors remain disabled. The reported evaluation work does not establish real-world stroke-detection accuracy.
- A separate multi-stroke foundation worktree added camera-view guidance and limitations to reports for all four strokes. It did not add stroke-specific detection for backstroke, butterfly, or breaststroke.
- Chronos lifecycle design work has clarified several failure cases, including the difference between engine-creation and warm-up failures. A possible partial callback-registration failure remains under audit.

## Product tools

| Tool | What it offers | Limits and status |
|---|---|---|
| **Chase AI** | The site provides swim-video upload and an analysis flow. The existing analysis pipeline uses browser-side MediaPipe Pose to extract 2D pose measurements and produce rule-based observations. | One camera provides 2D proxies, not 3D motion or force measurements. Freestyle is the only stroke with documented cycle detection. Other strokes may show generic pose measurements, but stroke-specific detectors for backstroke, butterfly, and breaststroke are not enabled. Accuracy has not been established against expert-labelled real footage. |
| **Chronos Engine** | The site provides race-video analysis controls, including event and course configuration, pre-start and lane-reference marking, automatic analysis, split review, and PB comparison. It also shows a manual race timer. | Race timing and splits should be treated as analysis aids, not validated measurement claims. Pose-adapter integration and lifecycle behavior are still being developed and reviewed. |
| **Wall of Records** | The site provides a personal-best tracker for recording and reviewing swimming times. | The project notes describe browser-local storage as the current data path; Firebase is configured but not documented as powering a working product feature. |
| **Athlete Profile** | The site provides fields for athlete details, swimming background, physical data, goals, and competition history. | Persistence and cross-device account behavior should not be assumed without a verified working account flow. |
| **War Room** | The site provides a meet-readiness questionnaire covering fatigue, sleep, soreness, nutrition, training intensity, mental readiness, and race type, plus a soreness body map. | Treat its generated plan as a planning aid. The project notes do not establish that its recommendations are clinically or scientifically validated. |
| **Coach ATLAS** | The site includes a floating chat interface. | The documented implementation is a keyword-matching FAQ responder, not an LLM, and it is not connected to video-analysis results. |

## Engineering work and validation

### Chase inference integrity

An inference-integrity change was prepared in PR #49 to prevent accepting pose results that cannot be tied to a frame send. The reported test work includes automated checks, but automated tests do not prove MediaPipe’s real-world result-to-frame behavior. Real MediaPipe and real-video validation were still outstanding in the project update.

### Pose adapter and lifecycle

A standalone Pose adapter has been prototyped with an injectable engine and deterministic fake-engine tests. It is designed to serialize sends, track warm-up and session state, and carry both frame-dispatch and callback-arrival timestamps.

The adapter is **not wired into Chase or Chronos**. Its smoke testing used synthetic input and does not validate real swim footage, long sessions, recovery after a hung send, or behavior across browsers and GPUs. Integration decisions and lifecycle audits are still in progress.

### Stroke evaluation foundation

PR #50 introduced an evaluation contract and harness using synthetic or scripted data. This helps prepare for future validation; it is not evidence that the detectors can identify stroke phases accurately in real video. The reported PR was open and had not been merged at the time of the project update.

Research and reporting work has also added guidance about camera views and what a single camera can or cannot show for freestyle, backstroke, butterfly, and breaststroke. This work does not enable new stroke-specific detectors.

## Current limitations

- The live product and the engineering prototypes do not have the same integration status. Some work described above remains on branches, in pull requests, or in separate worktrees.
- Pose measurements are single-camera 2D estimates. They are not 3D reconstruction, force measurement, or a substitute for coach review.
- Freestyle is the only stroke with documented stroke-cycle detection; the other three strokes do not yet have enabled, validated stroke-specific detectors.
- There is no documented expert-labelled real-video evaluation dataset establishing detection accuracy.
- Firebase is configured, but the project notes identify browser `localStorage` as the working data store for current features.
- The documented Coach ATLAS implementation is a keyword-based FAQ responder and is not connected to analysis results.
- Login and sign-up behavior should be verified against the current deployed code before being described as working.

## Repository and project guidance

Start with [`CLAUDE.md`](https://github.com/abhaylakkoju1-afk/chase-ai/blob/main/CLAUDE.md), the project’s working contract for contributors and Claude Code sessions.

- [`docs/ARCHITECTURE.md`](https://github.com/abhaylakkoju1-afk/chase-ai/blob/main/docs/ARCHITECTURE.md) — current system architecture and analysis pipeline.
- [`docs/ROADMAP.md`](https://github.com/abhaylakkoju1-afk/chase-ai/blob/main/docs/ROADMAP.md) — planned development phases.
- [`docs/DEVELOPMENT_WORKFLOW.md`](https://github.com/abhaylakkoju1-afk/chase-ai/blob/main/docs/DEVELOPMENT_WORKFLOW.md) — branch, review, and release workflow.
- [`docs/DECISIONS.md`](https://github.com/abhaylakkoju1-afk/chase-ai/blob/main/docs/DECISIONS.md) — recorded architectural decisions and known issues.

The live product is available at [swimtics.com](https://swimtics.com/).

## Direction

The next steps are to finish reviewing the inference lifecycle, integrate changes only after the relevant behavior is settled, and build a real evaluation process using consented footage and independent expert labels. Stroke-specific coaching should be enabled only when its measurements and event detection have been evaluated for the relevant stroke and camera view.
