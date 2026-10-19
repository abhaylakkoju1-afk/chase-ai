/* =========================================================
   SUPABASE TEST MODE — config for Vercel PREVIEW deployments only
   A Vercel Function (Node runtime). Supabase test mode on a preview URL
   (swimtics-web-…-swim-tics.vercel.app/?supabase) asks this endpoint for
   the swimtics-test project URL and publishable key, which are read at
   request time from two environment variables set in Vercel for the
   Preview environment only:
       SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY
   No value is stored in the repository or in any deployed file.

   It answers only when Vercel reports this deployment as a Preview
   (VERCEL_ENV === "preview"); on Production and anywhere else it is 404,
   even if the variables were set there by mistake. A secret or
   service_role key is refused and never echoed. Preview URLs stay behind
   Vercel Deployment Protection, which also covers this endpoint.

   GitHub Pages (swimtics.com) only serves this file as plain text; it
   holds no values and runs nothing there.
   ========================================================= */

import { checkPublicConfig } from "../src/app/data/supabase-test-core.js";

/* Pure: what to answer for these environment variables. */
export function previewConfigResponse(env = {}) {
    if (env.VERCEL_ENV !== "preview") {
        return { status: 404, body: { error: "not available" } };
    }
    const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || "").trim();
    if (!url && !publishableKey) {
        return { status: 404, body: { error: "Supabase test mode is not configured for previews." } };
    }
    const check = checkPublicConfig({ url, publishableKey });
    if (!check.ok) {
        return { status: 500, body: { error: `Preview Supabase configuration refused: ${check.reason}` } };
    }
    return { status: 200, body: { url, publishableKey } };
}

export default function handler(req, res) {
    const { status, body } = previewConfigResponse(process.env);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.end(JSON.stringify(body));
}
