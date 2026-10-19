/* =========================================================
   ANALYTICS CONSENT — stored choice and cookie clean-up (pure)
   No DOM access here, so it can be unit-tested in Node. The browser
   side (notice, settings dialog, loading Google Analytics) is
   consent.js.
   ========================================================= */

export const CONSENT_KEY = "swimtics:analyticsConsent";

/* Bump when the notice's wording or the analytics it covers changes:
   a saved choice with another version is treated as no choice, so the
   notice is shown again and nothing loads until the visitor chooses. */
export const CONSENT_VERSION = 1;

export const CHOICES = Object.freeze(["accept", "decline"]);

export function createRecord(choice, now = new Date()) {
    if (!CHOICES.includes(choice)) throw new Error(`unknown consent choice: ${choice}`);
    return { choice, version: CONSENT_VERSION, at: now.toISOString() };
}

/* A saved choice lasts this many calendar months; after that the visitor
   is asked again. */
export const CONSENT_MAX_AGE_MONTHS = 12;

export function expiresAt(at) {
    const d = new Date(at);
    d.setUTCMonth(d.getUTCMonth() + CONSENT_MAX_AGE_MONTHS);
    return d;
}

/* Returns the saved record only if it is well formed, for the current
   version and less than CONSENT_MAX_AGE_MONTHS old; anything else
   (missing, corrupt, older version, expired) is null. */
export function parseRecord(raw, now = new Date()) {
    if (typeof raw !== "string" || raw === "") return null;
    let value;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!value || typeof value !== "object") return null;
    if (value.version !== CONSENT_VERSION) return null;
    if (!CHOICES.includes(value.choice)) return null;
    if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return null;
    if (now.getTime() >= expiresAt(value.at).getTime()) return null;
    return { choice: value.choice, version: value.version, at: value.at };
}

export function analyticsAllowed(record) {
    return !!record && record.choice === "accept";
}

/* First-party cookies set by Google Analytics (gtag.js) and, from before
   it was paused, Microsoft Clarity. Third-party cookies on Google's or
   Microsoft's own domains can't be removed by this site. */
const EXACT = new Set(["_ga", "_gid", "_gat", "_clck", "_clsk", "_uetsid", "_uetvid", "_uetmsclkid"]);
const PREFIXES = ["_ga_", "_gat_", "_gac_"];

export function isAnalyticsCookie(name) {
    return EXACT.has(name) || PREFIXES.some((p) => name.startsWith(p));
}

export function cookieNames(cookieString) {
    return String(cookieString || "")
        .split(";")
        .map((part) => part.split("=")[0].trim())
        .filter(Boolean);
}

/* Domains a cookie for this page could have been set on: no domain
   (host-only) plus the host and each parent domain, e.g. for
   www.swimtics.com: "", "www.swimtics.com", "swimtics.com". */
export function cookieDomains(hostname) {
    const host = String(hostname || "").toLowerCase();
    if (!host || /^[\d.]+$/.test(host) || host.includes(":") || !host.includes(".")) return [""];
    const parts = host.split(".");
    const domains = [""];
    for (let i = 0; i < parts.length - 1; i++) domains.push(parts.slice(i).join("."));
    return domains;
}

/* The cookie strings that expire every analytics cookie currently
   visible to the page, on every domain it could belong to. */
export function expiryCookies(cookieString, hostname) {
    const names = [...new Set(cookieNames(cookieString).filter(isAnalyticsCookie))];
    const out = [];
    for (const name of names) {
        for (const domain of cookieDomains(hostname)) {
            out.push(`${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=/${domain ? `; domain=${domain}` : ""}`);
        }
    }
    return out;
}
