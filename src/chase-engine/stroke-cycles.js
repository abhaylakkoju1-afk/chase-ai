// Chase engine — freestyle stroke-cycle detection.
//
// This is a plain classic script, not an ES module (no export/import).
// It is loaded via a normal <script src="..."> tag, which executes
// synchronously and immediately at its position in the document —
// exactly like the classic inline script that used to define this
// function. See src/chase-engine/geometry.js for the loading-order
// reasoning, established there first.
//
// chaseDetectFreestyleCycles() reads a module-level `metricsHistory`
// object as an implicit global (declared in the giant application
// script, populated frame-by-frame by onChasePoseResults during
// analysis) and calls summariseMetric (src/chase-engine/stats.js).
// This is a deliberate, unchanged dependency for this extraction —
// parameterizing `metricsHistory` is an explicitly deferred, separate
// architectural decision, not part of this move.
//
// Approach: the recovery arm lifts out of the water once per stroke,
// producing a local minimum in wristMinY (smaller y = higher in the
// frame). We scan the stored signal for local minima at least
// `refractoryMs` apart (to avoid tracking jitter being counted as
// extra strokes), then treat each gap between consecutive minima as
// one stroke cycle. For each cycle we average whatever elbow-angle
// samples fall inside that time window.
//
// This is a real, if simple, cycle detector — not an illusion of one.
// Its accuracy depends entirely on wrist-tracking quality and camera
// angle, which is why the final report states this explicitly rather
// than presenting cycle numbers as precise.
//
// Function body is unchanged from its original inline definition.

function chaseDetectFreestyleCycles() {

    const y = metricsHistory.wristMinY;
    const t = metricsHistory.timestamps;
    const elbow = metricsHistory.elbow;

    if (!y || y.length < 8) return [];

    const refractoryMs = 300;
    const minima = [];
    let lastMinimaTime = -Infinity;

    for (let i = 1; i < y.length - 1; i++) {

        if (!Number.isFinite(y[i]) || !Number.isFinite(y[i - 1]) || !Number.isFinite(y[i + 1])) {
            continue;
        }

        if (y[i] < y[i - 1] && y[i] <= y[i + 1]) {
            if (t[i] - lastMinimaTime > refractoryMs) {
                minima.push({ index: i, time: t[i] });
                lastMinimaTime = t[i];
            }
        }
    }

    if (minima.length < 2) return [];

    const cycles = [];

    for (let i = 0; i < minima.length - 1; i++) {

        const startTime = minima[i].time;
        const endTime = minima[i + 1].time;

        const elbowInWindow = [];

        for (let j = 0; j < t.length; j++) {
            if (t[j] >= startTime && t[j] < endTime && Number.isFinite(elbow[j])) {
                elbowInWindow.push(elbow[j]);
            }
        }

        const elbowStats = summariseMetric(elbowInWindow);
        const durationMs = endTime - startTime;

        cycles.push({
            cycleNumber: i + 1,
            durationMs,
            strokeRatePerMin: durationMs > 0 ? 60000 / durationMs : null,
            elbowMean: elbowStats.count ? elbowStats.mean : null,
            elbowStdDev: elbowStats.count ? elbowStats.stdDev : null,
            sampleCount: elbowStats.count
        });
    }

    return cycles;
}
