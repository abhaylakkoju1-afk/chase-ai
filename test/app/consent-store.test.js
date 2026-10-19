import { test } from "node:test";
import assert from "node:assert/strict";
import {
    CONSENT_VERSION, CONSENT_MAX_AGE_MONTHS, createRecord, parseRecord, analyticsAllowed, expiresAt,
    isAnalyticsCookie, cookieNames, cookieDomains, expiryCookies,
} from "../../src/app/privacy/consent-store.js";

test("a record stores the choice, the current consent version and a timestamp", () => {
    const at = new Date("2026-10-18T09:30:00Z");
    assert.deepEqual(createRecord("accept", at), { choice: "accept", version: CONSENT_VERSION, at: "2026-10-18T09:30:00.000Z" });
    assert.deepEqual(createRecord("decline", at).choice, "decline");
    assert.throws(() => createRecord("maybe"));
});

test("only a well-formed record for the current version counts as a choice", () => {
    const ok = JSON.stringify(createRecord("decline", new Date("2026-10-18T00:00:00Z")));
    const soon = new Date("2026-10-19T00:00:00Z");
    assert.equal(parseRecord(ok, soon).choice, "decline");
    for (const raw of [
        null, "", "not json", "null", "[]", "\"accept\"",
        JSON.stringify({ choice: "accept", version: CONSENT_VERSION - 1, at: "2026-10-18T00:00:00Z" }),
        JSON.stringify({ choice: "accept", version: CONSENT_VERSION + 1, at: "2026-10-18T00:00:00Z" }),
        JSON.stringify({ choice: "yes", version: CONSENT_VERSION, at: "2026-10-18T00:00:00Z" }),
        JSON.stringify({ choice: "accept", version: CONSENT_VERSION }),
        JSON.stringify({ choice: "accept", version: CONSENT_VERSION, at: "not a date" }),
    ]) {
        assert.equal(parseRecord(raw, soon), null, `should be rejected: ${raw}`);
    }
});

test("a saved choice expires 12 calendar months after it was made", () => {
    assert.equal(CONSENT_MAX_AGE_MONTHS, 12);
    const raw = JSON.stringify(createRecord("accept", new Date("2026-10-18T09:30:00Z")));
    assert.equal(expiresAt("2026-10-18T09:30:00.000Z").toISOString(), "2027-10-18T09:30:00.000Z");
    assert.equal(parseRecord(raw, new Date("2027-10-18T09:29:59.999Z")).choice, "accept");   // last moment it counts
    assert.equal(parseRecord(raw, new Date("2027-10-18T09:30:00.000Z")), null);              // expired: ask again
    assert.equal(parseRecord(raw, new Date("2029-01-01T00:00:00Z")), null);
    // calendar months, so a leap day rolls over rather than shortening the year
    assert.equal(expiresAt("2028-02-29T12:00:00.000Z").toISOString(), "2029-03-01T12:00:00.000Z");
});

test("analytics are allowed only by a current accept", () => {
    assert.equal(analyticsAllowed(null), false);
    assert.equal(analyticsAllowed(createRecord("decline")), false);
    assert.equal(analyticsAllowed(createRecord("accept")), true);
});

test("recognises Google Analytics and paused-Clarity cookies, nothing else", () => {
    for (const name of ["_ga", "_ga_VSLDBW2PYM", "_gid", "_gat", "_gat_UA-1", "_gac_x", "_clck", "_clsk", "_uetvid", "_uetsid", "_uetmsclkid"]) {
        assert.equal(isAnalyticsCookie(name), true, name);
    }
    for (const name of ["theme", "firebase:authUser", "_gax", "ga", "session"]) {
        assert.equal(isAnalyticsCookie(name), false, name);
    }
});

test("cookie domains cover host-only, the host and each parent domain", () => {
    assert.deepEqual(cookieDomains("www.swimtics.com"), ["", "www.swimtics.com", "swimtics.com"]);
    assert.deepEqual(cookieDomains("swimtics.com"), ["", "swimtics.com"]);
    assert.deepEqual(cookieDomains("127.0.0.1"), [""]);
    assert.deepEqual(cookieDomains("localhost"), [""]);
});

test("expiry cookies are produced only for analytics cookies, on every domain", () => {
    const names = cookieNames("theme=dark; _ga=GA1.1.1; _ga_VSLDBW2PYM=GS1; _clck=abc; other=1");
    assert.deepEqual(names, ["theme", "_ga", "_ga_VSLDBW2PYM", "_clck", "other"]);
    const out = expiryCookies("theme=dark; _ga=GA1.1.1; _clck=abc", "swimtics.com");
    assert.equal(out.length, 4);
    assert.ok(out.every((c) => /^(_ga|_clck)=; expires=Thu, 01 Jan 1970/.test(c) && c.includes("path=/")));
    assert.ok(out.some((c) => c.startsWith("_ga=") && c.endsWith("domain=swimtics.com")));
    assert.ok(out.some((c) => c.startsWith("_ga=") && !c.includes("domain=")));
    assert.deepEqual(expiryCookies("theme=dark", "swimtics.com"), []);
});
