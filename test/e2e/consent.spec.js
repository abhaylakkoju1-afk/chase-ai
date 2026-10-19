// Analytics consent: Google Analytics may load only after the visitor
// accepts, the choice persists (with a version and timestamp), it can be
// withdrawn from Tools → Privacy & cookies, and Microsoft Clarity is never
// loaded. Every request to an analytics host is recorded; hits that would
// send data (…/collect) are always aborted, so these tests never send
// analytics data anywhere. gtag.js itself is fetched for real only in the
// tests where the visitor accepts.

import { test, expect, devices } from "@playwright/test";

const ANALYTICS = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|clarity\.ms|bing\.com/;
const KEY = "swimtics:analyticsConsent";

async function recordAnalytics(page, { allowGtagScript = false } = {}) {
  const requests = [];
  await page.route(ANALYTICS, (route) => {
    const url = route.request().url();
    requests.push(url);
    if (allowGtagScript && /googletagmanager\.com\/gtag\/js/.test(url)) return route.continue();
    return route.abort();
  });
  return {
    all: () => [...requests],
    gtagScript: () => requests.filter((u) => /googletagmanager\.com\/gtag\/js/.test(u)),
    collects: () => requests.filter((u) => /\/collect/.test(u)),
    clarity: () => requests.filter((u) => /clarity\.ms/.test(u)),
  };
}

async function enter(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

const banner = (page) => page.locator("#consentBanner");
const saved = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), KEY);
const analyticsCookies = (page) => page.evaluate(() =>
  document.cookie.split(";").map((c) => c.split("=")[0].trim()).filter((n) => /^(_ga|_gid|_gat|_clck|_clsk|_uet)/.test(n)));

async function openPrivacySettings(page) {
  await page.locator("#siteNavToolsButton").click();
  await page.locator("#siteNavToolsMenu button", { hasText: "Privacy & cookies" }).click();
  await expect(page.locator("#privacyDialog")).toBeVisible();
}

test("no analytics requests before a choice, and Clarity is never requested", async ({ page }) => {
  const net = await recordAnalytics(page);
  await page.goto("/");

  // the notice never sits over the entry gate
  await expect(page.locator("#entryGate")).toBeVisible();
  await expect(banner(page)).toBeHidden();

  await enter(page);
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).getByRole("button", { name: "Accept analytics" })).toBeVisible();
  await expect(banner(page).getByRole("button", { name: "Decline" })).toBeVisible();
  await expect(banner(page)).toContainText("Google Analytics");
  await expect(banner(page)).toContainText("Microsoft Clarity session recording is currently turned off");
  const acceptBox = await banner(page).getByRole("button", { name: "Accept analytics" }).boundingBox();
  const declineBox = await banner(page).getByRole("button", { name: "Decline" }).boundingBox();
  expect(Math.abs(acceptBox.width - declineBox.width), "both choices are the same size").toBeLessThan(1);
  expect(Math.abs(acceptBox.height - declineBox.height)).toBeLessThan(1);

  await page.waitForTimeout(1500);
  expect(net.all()).toEqual([]);
  expect(await page.evaluate(() => typeof window.gtag)).toBe("undefined");
  expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
  expect(await page.locator('script[src*="clarity.ms"], script[src*="googletagmanager"]').count()).toBe(0);
});

test("Decline is saved with a version and timestamp, and persists across reloads", async ({ page }) => {
  const net = await recordAnalytics(page);
  await page.goto("/");
  await enter(page);

  const before = Date.now();
  await banner(page).getByRole("button", { name: "Decline" }).click();
  await expect(banner(page)).toBeHidden();
  const record = await saved(page);
  expect(record.choice).toBe("decline");
  expect(record.version).toBe(1);
  expect(Date.parse(record.at)).toBeGreaterThanOrEqual(before - 1000);

  await page.reload();
  await enter(page);
  await page.waitForTimeout(1500);
  await expect(banner(page)).toBeHidden();
  expect(net.all()).toEqual([]);
  expect(await saved(page)).toEqual(record);
});

test("Accept loads Google Analytics only after the click, and on later visits without asking again", async ({ page }) => {
  const net = await recordAnalytics(page, { allowGtagScript: true });
  await page.goto("/");
  await enter(page);
  await page.waitForTimeout(1000);
  expect(net.all()).toEqual([]);

  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect(banner(page)).toBeHidden();
  await expect.poll(() => net.gtagScript().length).toBe(1);
  expect((await saved(page)).choice).toBe("accept");

  await page.reload();
  await expect.poll(() => net.gtagScript().length).toBe(2);   // loads straight away on a return visit
  await enter(page);
  await expect(banner(page)).toBeHidden();
  expect(net.clarity()).toEqual([]);
});

test("a saved choice from an older consent version, or a corrupt one, is ignored", async ({ page }) => {
  const net = await recordAnalytics(page);
  await page.addInitScript((k) => {
    localStorage.setItem(k, JSON.stringify({ choice: "accept", version: 0, at: "2026-01-01T00:00:00.000Z" }));
  }, KEY);
  await page.goto("/");
  await enter(page);
  await expect(banner(page)).toBeVisible();
  await page.waitForTimeout(1000);
  expect(net.all()).toEqual([]);

  await page.evaluate((k) => localStorage.setItem(k, "{not json"), KEY);
  await page.reload();
  await enter(page);
  await expect(banner(page)).toBeVisible();
  expect(net.all()).toEqual([]);
});

test("withdrawing in Privacy & cookies stops further analytics and removes analytics cookies", async ({ page }) => {
  const net = await recordAnalytics(page, { allowGtagScript: true });
  await page.goto("/");
  await enter(page);
  await banner(page).getByRole("button", { name: "Accept analytics" }).click();

  // Google Analytics is really running: it tries to send a hit (aborted here)
  await expect.poll(() => net.collects().length, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.evaluate(() => { document.cookie = "_clck=left-over-from-clarity; path=/"; });
  await expect.poll(() => analyticsCookies(page)).toContain("_ga");

  await openPrivacySettings(page);
  await expect(page.locator("#privacyStatus")).toContainText("You accepted optional analytics");
  const hitsAtWithdrawal = net.collects().length;
  await page.locator("#privacyDialog").getByRole("button", { name: "Decline" }).click();
  await expect(page.locator("#privacyResult")).toContainText("Google Analytics is off");
  await expect(page.locator("#privacyStatus")).toContainText("You declined optional analytics");
  expect((await saved(page)).choice).toBe("decline");
  expect(await analyticsCookies(page)).toEqual([]);

  // nothing further is sent from this page and no cookie comes back.
  // (gtag's own automatic events can still fire after its ga-disable flag
  // is set — e.g. a "scroll" event about 3 s later — so wait past that.)
  await page.evaluate(() => window.gtag("event", "after_withdrawal"));
  await page.waitForTimeout(5000);
  const describeHits = (urls) => urls.map((u) => new URL(u).searchParams.get("en")).join(", ");
  expect(describeHits(net.collects().slice(hitsAtWithdrawal)), "events sent after withdrawal").toBe("");
  expect(await analyticsCookies(page)).toEqual([]);

  // and nothing loads on the next visit
  const scriptsBefore = net.gtagScript().length;
  await page.reload();
  await enter(page);
  await page.waitForTimeout(1500);
  expect(net.gtagScript().length).toBe(scriptsBefore);
  await expect(banner(page)).toBeHidden();
  expect(net.clarity()).toEqual([]);
});

test("after withdrawal the guard refuses analytics requests by every way gtag sends them, and nothing else", async ({ page }) => {
  const net = await recordAnalytics(page, { allowGtagScript: true });
  await page.goto("/");
  await enter(page);

  // a visitor who never accepted gets no patched browser functions at all
  expect(await page.evaluate(() => [fetch, navigator.sendBeacon, XMLHttpRequest.prototype.send]
    .every((f) => /\[native code\]/.test(Function.prototype.toString.call(f))))).toBe(true);

  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => net.gtagScript().length).toBe(1);
  await openPrivacySettings(page);
  await page.locator("#privacyDialog").getByRole("button", { name: "Decline" }).click();
  await expect(page.locator("#privacyResult")).toContainText("Google Analytics is off");
  const before = net.all().length;

  const result = await page.evaluate(async () => {
    const ga = (en) => `https://www.google-analytics.com/g/collect?v=2&en=${en}`;
    const out = {};
    // refused sends look successful to gtag, so it doesn't fall back to another transport
    out.beacon = navigator.sendBeacon(ga("probe_beacon"), "x");
    out.fetch = (await fetch(ga("probe_fetch"), { method: "POST", body: "x" })).status;
    out.fetchRequest = (await fetch(new Request(ga("probe_fetch_request"), { method: "POST", body: "x" }))).status;
    const x = new XMLHttpRequest(); x.open("POST", ga("probe_xhr")); x.send("x");
    new Image().src = ga("probe_image");
    const s = document.createElement("script"); s.src = ga("probe_script"); document.head.appendChild(s);
    navigator.sendBeacon("https://stats.g.doubleclick.net/g/collect?v=2&en=probe_doubleclick", "x");
    navigator.sendBeacon("https://region1.google-analytics.com:443/g/collect?v=2&en=probe_port", "x");

    // unrelated requests are untouched
    out.sameOriginFetch = (await fetch("/favicon.png?guard-fetch")).status;
    out.requestObject = (await fetch(new Request("/index.html"))).status;
    out.urlObject = (await fetch(new URL("/favicon.png?guard-url", location.href))).status;
    out.sameOriginBeacon = navigator.sendBeacon("/favicon.png?guard-beacon", "x");
    out.xhr = await new Promise((res) => { const r = new XMLHttpRequest(); r.open("GET", "/favicon.png?guard-xhr"); r.onload = () => res(r.status); r.onerror = () => res("error"); r.send(); });
    out.image = await new Promise((res) => { const i = new Image(); i.onload = () => res(i.naturalWidth > 0); i.onerror = () => res(false); i.src = "/favicon.png?guard-img"; });
    out.lookalikeHost = new URL("https://google-analytics.com.example.org/x").host;  // shape check only
    return out;
  });
  await page.waitForTimeout(1500);

  expect(net.all().slice(before), "requests to analytics hosts after withdrawal").toEqual([]);
  expect(result).toMatchObject({
    beacon: true, fetch: 204, fetchRequest: 204,
    sameOriginFetch: 200, requestObject: 200, urlObject: 200, sameOriginBeacon: true, xhr: 200, image: true,
  });
});

for (const [label, stored] of [
  ["no saved", null],
  ["a corrupt", "{not json"],
  ["an outdated", JSON.stringify({ choice: "accept", version: 0, at: "2026-01-01T00:00:00.000Z" })],
]) {
  test(`with ${label} consent record, left-over analytics cookies are removed at startup without loading analytics`, async ({ page, context }) => {
    const net = await recordAnalytics(page);
    const seeded = ["_ga", "_ga_VSLDBW2PYM", "_gid", "_clck", "_clsk", "_uetvid"];
    await context.addCookies([...seeded, "unrelated_pref"].map((name) => ({
      name, value: "seeded", domain: "127.0.0.1", path: "/",
    })));
    if (stored !== null) await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, stored]);

    await page.goto("/");
    await expect.poll(async () => (await context.cookies()).map((c) => c.name).sort())
      .toEqual(["unrelated_pref"]);
    await enter(page);
    await expect(banner(page)).toBeVisible();
    await page.waitForTimeout(1000);
    expect(net.all()).toEqual([]);
    expect(await page.locator('script[src*="clarity.ms"], script[src*="googletagmanager"]').count()).toBe(0);
  });
}

test("an XHR opened while analytics was accepted can't be sent after withdrawal; ordinary XHR still works", async ({ page }) => {
  const net = await recordAnalytics(page, { allowGtagScript: true });
  await page.goto("/");
  await enter(page);
  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => net.gtagScript().length).toBe(1);

  // both opened while analytics is allowed (the guard is installed by now)
  await page.evaluate(() => {
    window.__gaXhr = new XMLHttpRequest();
    window.__gaXhr.open("POST", "https://www.google-analytics.com/g/collect?v=2&en=opened_before_withdrawal");
    window.__siteXhr = new XMLHttpRequest();
    window.__siteXhr.open("GET", "/favicon.png?opened-before-withdrawal");
  });

  await openPrivacySettings(page);
  await page.locator("#privacyDialog").getByRole("button", { name: "Decline" }).click();
  await expect(page.locator("#privacyResult")).toContainText("Google Analytics is off");
  const before = net.all().length;

  const result = await page.evaluate(async () => {
    const done = (xhr) => new Promise((res) => {
      xhr.onload = () => res(xhr.status); xhr.onerror = () => res("error");
    });
    window.__gaXhr.send("x");
    const siteDone = done(window.__siteXhr);
    window.__siteXhr.send();
    const fresh = new XMLHttpRequest();
    fresh.open("GET", "/index.html?after-withdrawal");
    const freshDone = done(fresh);
    fresh.send();
    return { openedBefore: await siteDone, openedAfter: await freshDone };
  });
  await page.waitForTimeout(1500);

  expect(net.all().slice(before), "analytics requests after withdrawal").toEqual([]);
  expect(result).toEqual({ openedBefore: 200, openedAfter: 200 });
});

test("a saved accept older than 12 months has expired: nothing loads, cookies are removed and the visitor is asked again", async ({ page, context }) => {
  const net = await recordAnalytics(page);
  const thirteenMonthsAgo = new Date(); thirteenMonthsAgo.setUTCMonth(thirteenMonthsAgo.getUTCMonth() - 13);
  await context.addCookies(["_ga", "_ga_VSLDBW2PYM", "_clck"].map((name) => ({ name, value: "seeded", domain: "127.0.0.1", path: "/" })));
  await page.addInitScript(([k, at]) => localStorage.setItem(k, JSON.stringify({ choice: "accept", version: 1, at })), [KEY, thirteenMonthsAgo.toISOString()]);

  await page.goto("/");
  await expect.poll(async () => (await context.cookies()).map((c) => c.name)).toEqual([]);
  await enter(page);
  await expect(banner(page)).toBeVisible();
  await page.waitForTimeout(1000);
  expect(net.all()).toEqual([]);

  // choosing again replaces the expired record with a fresh one
  await banner(page).getByRole("button", { name: "Decline" }).click();
  const record = await saved(page);
  expect(record.choice).toBe("decline");
  expect(Date.now() - Date.parse(record.at)).toBeLessThan(60_000);
});

test("a saved accept less than 12 months old still applies without asking", async ({ page }) => {
  const net = await recordAnalytics(page, { allowGtagScript: true });
  const elevenMonthsAgo = new Date(); elevenMonthsAgo.setUTCMonth(elevenMonthsAgo.getUTCMonth() - 11);
  await page.addInitScript(([k, at]) => localStorage.setItem(k, JSON.stringify({ choice: "accept", version: 1, at })), [KEY, elevenMonthsAgo.toISOString()]);
  await page.goto("/");
  await expect.poll(() => net.gtagScript().length).toBe(1);
  await enter(page);
  await expect(banner(page)).toBeHidden();
  expect(net.clarity()).toEqual([]);
});

test("keyboard and screen readers: the notice is reachable by Tab, and the dialog opens from Tools and returns focus", async ({ page }) => {
  await recordAnalytics(page);
  await page.goto("/");
  await enter(page);
  await expect(banner(page)).toBeVisible();

  // the notice is a labelled region early in the Tab order
  await expect(page.getByRole("region", { name: "Optional analytics" })).toBeVisible();
  let reached = false;
  for (let i = 0; i < 8 && !reached; i++) {
    await page.keyboard.press("Tab");
    reached = await page.evaluate(() => !!document.activeElement.closest("#consentBanner"));
  }
  expect(reached, "Tab reaches the consent buttons").toBe(true);

  // Tools menu by keyboard → Privacy & cookies (last item)
  await page.locator("#siteNavToolsButton").focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#siteNavToolsMenu button", { hasText: "Privacy & cookies" })).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Privacy & cookies" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Accept analytics" })).toBeFocused();
  await expect(page.locator("#privacyStatus")).toHaveText("You haven't made a choice yet, so Google Analytics is off.");
  await expect(dialog).toContainText("Your choice lasts 12 months; after that we'll ask again.");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#siteNavToolsButton")).toBeFocused();
});

test.describe("mobile", () => {
  // Pixel 7's phone settings (touch, mobile viewport, user agent), minus
  // defaultBrowserType, which can't be set inside a describe group
  const { defaultBrowserType, ...pixel7 } = devices["Pixel 7"];
  test.use(pixel7);

  for (const viewport of [{ width: 412, height: 839 }, { width: 320, height: 640 }]) {
    test(`at ${viewport.width}px the notice fits, leaves the gate and controls uncovered, and both choices are equal`, async ({ page }) => {
      await recordAnalytics(page);
      await page.setViewportSize(viewport);
      await page.goto("/");

      await expect(page.locator("#enterButton")).toBeVisible();
      await expect(banner(page)).toBeHidden();
      await enter(page);
      await expect(banner(page)).toBeVisible();

      const box = await banner(page).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 0.5);
      expect(box.height).toBeLessThan(viewport.height * 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      const accept = await banner(page).getByRole("button", { name: "Accept analytics" }).boundingBox();
      const decline = await banner(page).getByRole("button", { name: "Decline" }).boundingBox();
      expect(Math.abs(accept.width - decline.width)).toBeLessThan(1);
      expect(Math.abs(accept.height - decline.height)).toBeLessThan(1);
      expect(accept.height).toBeGreaterThanOrEqual(44);

      const nav = await page.locator(".site-nav").boundingBox();
      expect(nav.y + nav.height).toBeLessThanOrEqual(box.y);

      // the floating theme / Coach ATLAS buttons are lifted clear of the notice
      for (const id of ["#themeToggle", "#aiCoachBtn"]) {
        await expect.poll(async () => {
          const b = await page.locator(id).boundingBox();
          return b ? b.y + b.height <= box.y + 0.5 : false;
        }, { message: `${id} sits above the notice` }).toBe(true);
      }

      // a tap on Decline works and frees the space again
      await banner(page).getByRole("button", { name: "Decline" }).tap();
      await expect(banner(page)).toBeHidden();
      expect(await page.evaluate(() => getComputedStyle(document.body).paddingBottom)).toBe("0px");
    });
  }

  test("Privacy & cookies opens from the Tools menu and fits the screen", async ({ page }) => {
    await recordAnalytics(page);
    await page.goto("/");
    await enter(page);
    await openPrivacySettings(page);
    const box = await page.locator("#privacyDialog").boundingBox();
    const vw = page.viewportSize().width;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw + 0.5);
    await page.locator("#privacyDialog").getByRole("button", { name: "Close" }).tap();
    await expect(page.locator("#privacyDialog")).toBeHidden();
  });
});
