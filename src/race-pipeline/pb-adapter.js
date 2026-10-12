// Race pipeline — read-only PB adapter (Stage 4D.8).
//
// A pure, read-only boundary between the Race pipeline and the EXISTING,
// PROTECTED PB system (index.html's `pbs` array / the "pbs" localStorage
// key). This file never mutates PB data, never writes localStorage, and
// never calls savePB()/editPB()/deletePB() — grep-verifiable: none of
// those identifiers appear anywhere below.
//
// RECONNAISSANCE FINDINGS (index.html, read before writing this file —
// Stage 4D.8 Step 1):
//
// 1. `pbs = JSON.parse(localStorage.getItem("pbs")) || []` — a plain
//    ARRAY of `{event, course, time, history}` objects
//    (index.html's savePB()/deletePB()/editPB()). `history` is an array
//    of numeric seconds pushed by savePB(); not read by this file.
// 2. `time` is free text typed into `<input id="time">` — never
//    validated or normalized at entry (e.g. "58.42", "1:02.35"). No
//    existing helper parses it into milliseconds.
// 3. `course` is exactly one of "Short Course" / "Long Course" (the
//    `<select id="course">` options) — the SAME vocabulary
//    `RACE_COURSE_OPTIONS` in ./race-config.js already mirrors.
// 4. `event` strings are the same 18-entry vocabulary
//    `RACE_EVENT_OPTIONS` in ./race-config.js already mirrors (confirmed
//    identical, Stage 4D.7).
// 5. `getPB(eventName)` (index.html) returns ONLY `pb.time` (a bare
//    string, or `"--"` if not found) — never the full record, and it
//    matches by `event` ALONE, never checking `course`. It is therefore
//    insufficient for `chronosComparePB()`, which needs the full
//    `{event, course, time, history}` shape to run its own event/course
//    compatibility check. This confirms src/chronos-engine/pb-comparison.js's
//    own header note, written before this adapter existed: "Obtaining a
//    full record will need a small lookup against the existing pbs
//    array directly... not a change to getPB() itself." This file is
//    exactly that lookup — `getPB()` itself is never called or modified.
// 6. No normalization/conversion happens in `getPB()` beyond the bare
//    array scan above.
// 7. No existing time-parsing helper beyond index.html's own
//    `timeToSeconds()`, which `pb-comparison.js`'s own header note
//    already documents as narrower than what's needed (no h:mm:ss
//    support) and deliberately NOT reused by `chronosComparePB()`. This
//    adapter follows the same discipline: it hands `pb.time` through
//    UNCHANGED — `chronosComparePB()`'s own `parsePbTimeToMs()` already
//    does the parsing (ss.ss / mm:ss.ss / h:mm:ss.ss), independently
//    tested in test/chronos-engine/pb-comparison.test.js. This file does
//    not parse time itself.
// 8. `displayPBs()` reads the same module-level `pbs` array directly (no
//    intermediate accessor) and renders `pb.time` verbatim as text.
// 9. PB data CAN be read without calling any existing mutation
//    function — `pbs` is kept in sync with `localStorage.getItem("pbs")`
//    on every mutation, so reading that same key directly (read-only)
//    reproduces the exact same data without touching the `pbs` variable,
//    which is never exposed on `window` and is therefore unreachable
//    from this ES module anyway (a classic-script top-level `let` is
//    scoped to that script, not attached to `window`).

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * Finds the PB record most relevant to a given event/course, from an
 * already-parsed `pbs` array — pure, no I/O, never mutates `pbs` or any
 * entry within it.
 *
 * Prefers an EXACT event+course match. If none exists but a record for
 * the same event exists under a DIFFERENT course, that record is
 * returned anyway (never `null`) so `chronosComparePB()`'s own,
 * already-built course-compatibility check can produce its accurate
 * `"incompatible-course"` result — this adapter does not decide
 * compatibility itself (Stage 4D.8 Step 3: "do not duplicate comparison
 * logic"); it only decides which existing record is worth handing to
 * the real comparison function.
 *
 * @param {Array<object>} pbs The existing PB array (as stored/returned
 *   by the protected PB system — never mutated).
 * @param {string} event Must match the PB system's own event vocabulary
 *   exactly (Stage 4D.7's RACE_EVENT_OPTIONS already mirrors it).
 * @param {string} course Must match the PB system's own course
 *   vocabulary exactly ("Short Course" | "Long Course").
 * @returns {object|null} The matching PB record, or null if the event
 *   has no PB recorded at all.
 */
export function racePipelineFindPbRecord(pbs, event, course) {
    if (!Array.isArray(pbs) || !isNonEmptyString(event)) {
        return null;
    }

    const exactMatch = pbs.find((pb) => pb && pb.event === event && pb.course === course);
    if (exactMatch) {
        return exactMatch;
    }

    const eventOnlyMatch = pbs.find((pb) => pb && pb.event === event);
    return eventOnlyMatch ?? null;
}

/**
 * Reads the existing PB array from localStorage — the ONE place in this
 * file that touches a browser global, isolated from
 * racePipelineFindPbRecord()'s pure logic above (Stage 4D.8's own
 * instruction: "isolate browser/localStorage access at the smallest
 * possible boundary"). Read-only: never calls `localStorage.setItem`.
 * Mirrors index.html's own `JSON.parse(localStorage.getItem("pbs")) ||
 * []` exactly, including its fallback to an empty array. Returns `[]`
 * (never throws) if localStorage is unavailable (e.g. this Node test
 * environment, which genuinely has no localStorage) or the stored value
 * is malformed.
 *
 * @returns {Array<object>}
 */
export function racePipelineReadStoredPbs() {
    try {
        const raw = localStorage.getItem("pbs");
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * The one-call convenience most callers actually want: read the
 * existing PB store, then find the record for this event/course. Still
 * fully read-only.
 *
 * @param {string} event
 * @param {string} course
 * @returns {object|null}
 */
export function racePipelineFindExistingPb(event, course) {
    return racePipelineFindPbRecord(racePipelineReadStoredPbs(), event, course);
}
