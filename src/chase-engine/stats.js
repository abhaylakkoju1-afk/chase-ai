// Chase engine — pure statistics helpers.
//
// This is a plain classic script, not an ES module (no export/import).
// It is loaded via a normal <script src="..."> tag, which executes
// synchronously and immediately at its position in the document —
// exactly like the classic inline script that used to define these
// functions. A `type="module"` script here would instead be deferred
// until after the whole document has parsed, executing AFTER the
// giant classic application script that calls these functions, which
// would silently break them. See src/chase-engine/geometry.js for the
// same reasoning, established there first.
//
// Function bodies are unchanged from their original inline definitions.

function averageValid(values) {

    const valid = values.filter(value => Number.isFinite(value));

    if (!valid.length) return null;

    return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function summariseMetric(values) {

    const valid = values.filter(value => Number.isFinite(value));

    if (!valid.length) {
        return { count: 0, mean: 0, stdDev: 0, min: 0, max: 0 };
    }

    const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;

    const variance =
        valid.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / valid.length;

    return {
        count: valid.length,
        mean,
        stdDev: Math.sqrt(variance),
        min: Math.min(...valid),
        max: Math.max(...valid)
    };
}
