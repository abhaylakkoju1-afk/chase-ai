// Research-informed camera and interpretation notes for the Chase report.
// These are static disclosures, not detections, measurements, or coaching
// rules. They describe what a suitable view may let a person inspect and
// what this single-camera analyzer cannot establish.

const CHASE_STROKE_REPORT_CONTEXT = Object.freeze({
    freestyle: Object.freeze({
        label: "Freestyle",
        view: "For manual review, a steady side or front-oblique view can show cycle timing, visible breathing events, and projected arm paths. Above-water footage does not show the underwater hand path.",
        limits: "This single view cannot establish true three-dimensional body roll, force, drag, or propulsive efficiency. Rate and cycle patterns vary with event pace and swimmer; this report does not compare them with a universal ideal."
    }),
    backstroke: Object.freeze({
        label: "Backstroke",
        view: "For manual review, a steady side view can show surface-level arm timing and projected body-line trends; an end-on view can show projected lateral movement. Underwater coverage is needed to inspect the underwater hand path.",
        limits: "A single view cannot establish true three-dimensional shoulder roll, underwater force, or neck comfort. Timing patterns vary with pace; this report does not prescribe a target roll angle or judge turn legality."
    }),
    butterfly: Object.freeze({
        label: "Butterfly",
        view: "For manual review, a steady side view with both arms and hips visible can show their apparent timing and visible body motion across a full cycle. Turbulence or occlusion may hide the knees and ankles.",
        limits: "A still pose cannot establish arm-to-leg timing, and one view cannot measure kick force, lumbar loading, drag, or energy cost. Timing changes with pace; this report does not prescribe a fixed body wave."
    }),
    breaststroke: Object.freeze({
        label: "Breaststroke",
        view: "For manual review, side-underwater footage can show arm-leg sequence, kick recovery, and glide; a frontal view can show projected left-right movement. Surface-only footage misses important kick details.",
        limits: "A single view cannot measure impulse, active drag, or energy cost. This analyzer does not judge rule compliance: timing, surfacing, and simultaneous wall contact require a view that clearly resolves each event and human review."
    })
});

function chaseGetStrokeReportContext(strokeKey) {
    return CHASE_STROKE_REPORT_CONTEXT[strokeKey] || CHASE_STROKE_REPORT_CONTEXT.freestyle;
}
