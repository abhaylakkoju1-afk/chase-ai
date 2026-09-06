// Chase engine — pure geometry helpers.
//
// This is a plain classic script, not an ES module (no export/import).
// It is loaded via a normal <script src="..."> tag, which executes
// synchronously and immediately at its position in the document —
// exactly like the classic inline script that used to define these
// functions. A `type="module"` script here would instead be deferred
// until after the whole document has parsed, executing AFTER the
// giant classic application script that calls these functions, which
// would silently break them.
//
// Function bodies are unchanged from their original inline definitions.

function midpoint(a, b) {

    if (!a || !b) return null;

    return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        z: ((a.z ?? 0) + (b.z ?? 0)) / 2
    };
}

function chaseCalculateAngle(a, b, c) {

    if (!a || !b || !c) return null;

    const abx = a.x - b.x;
    const aby = a.y - b.y;
    const cbx = c.x - b.x;
    const cby = c.y - b.y;

    const magnitudeAB = Math.hypot(abx, aby);
    const magnitudeCB = Math.hypot(cbx, cby);

    if (!magnitudeAB || !magnitudeCB) return null;

    const cosine =
        (abx * cbx + aby * cby) /
        (magnitudeAB * magnitudeCB);

    return Math.acos(
        Math.max(-1, Math.min(1, cosine))
    ) * 180 / Math.PI;
}

function calculateLineAngle(a, b) {

    if (!a || !b) return null;

    return Math.abs(
        Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
    );
}

function isVisible(point, threshold = 0.35) {

    return !!(
        point &&
        (point.visibility ?? 1) >= threshold
    );
}
