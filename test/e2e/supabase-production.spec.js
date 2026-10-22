// Production Supabase accounts (src/app/data/production-accounts.js, D15) —
// OFF. The app is served under its real hostnames through a Playwright
// route, as in supabase-preview.spec.js. With the flag off (as shipped)
// production pages load nothing about Supabase. To check the gates behind
// the flag, some tests serve a copy of accounts-flags.js with the flag
// turned on (and one serves supabase-env.js with a stand-in production
// project ref) — in the browser only; the files on disk stay as shipped.
// Supabase is the in-memory stand-in from support/fake-supabase.js; nothing
// real is contacted.

import { test, expect } from "@playwright/test";
import { createFakeSupabase, FAKE_URL, FAKE_KEY } from "./support/fake-supabase.js";

const PRODUCTION_HOSTS = ["swimtics.com", "www.swimtics.com"];
const PREVIEW = "swimtics-web-git-feat-supabase-auth-test-swim-tics.vercel.app";
const ANALYTICS = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
const PASSWORD = "swim-fast-123";
/* everything production mode could load beyond its tiny entry files */
const SUPABASE_LOADS = /supabase-accounts-core\.js|supabase-env\.js|supabase-production-config\.js|supabase-test-pbs\.js|@supabase\/supabase-js|\.supabase\.co/;

/* Serve this checkout for `hosts`; `overrides` maps a path to a function
   that edits that file's text before it is served. */
async function serveAs(context, baseURL, hosts, { overrides = {}, productionConfig = null } = {}) {
  const hostPattern = new RegExp(`^https://(${hosts.map((h) => h.replace(/\./g, "\\.")).join("|")})/`);
  await context.route(ANALYTICS, (r) => r.abort());
  await context.route(hostPattern, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/src/app/data/supabase-production-config.js") {
      if (!productionConfig) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: "text/javascript", body: `export default ${JSON.stringify(productionConfig)};` });
    }
    const r = await fetch(`${baseURL}${u.pathname}`);
    let body = Buffer.from(await r.arrayBuffer());
    if (overrides[u.pathname]) body = Buffer.from(overrides[u.pathname](body.toString("utf8")));
    return route.fulfill({
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" },
      body,
    });
  });
}

const flagOn = {
  "/src/app/data/accounts-flags.js": (s) => {
    const out = s.replace("PRODUCTION_SUPABASE_ACCOUNTS = false", "PRODUCTION_SUPABASE_ACCOUNTS = true");
    if (out === s) throw new Error("flag line not found");
    return out;
  },
};
/* production project = the stand-in's project (only in this browser) */
const fakeProductionRef = {
  "/src/app/data/supabase-env.js": (s) => {
    const out = s.replace("PRODUCTION_PROJECT_REF = null", `PRODUCTION_PROJECT_REF = "${new URL(FAKE_URL).hostname.split(".")[0]}"`);
    if (out === s) throw new Error("ref line not found");
    return out;
  },
};

function recordLoads(page) {
  const seen = [];
  page.on("request", (r) => { if (SUPABASE_LOADS.test(r.url())) seen.push(r.url()); });
  return seen;
}

async function enter(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

async function cardText(page) {
  await page.evaluate(() => window.showPage("profile"));
  return page.locator("#accountDetails").innerText();
}

test.beforeEach(async ({ context }) => {
  await context.route(ANALYTICS, (r) => r.abort());
});

for (const host of PRODUCTION_HOSTS) {
  for (const search of ["", "?supabase"]) {
    test(`flag off (as shipped): https://${host}/${search} loads nothing about Supabase and keeps Firebase's notice`, async ({ page, context, baseURL }) => {
      const fake = createFakeSupabase();
      await fake.install(context);
      await serveAs(context, baseURL, [host], { productionConfig: { url: FAKE_URL, publishableKey: FAKE_KEY } });
      const seen = recordLoads(page);
      await page.goto(`https://${host}/${search}`);
      await enter(page);
      expect(await cardText(page)).toContain("Accounts aren't available yet");
      await page.waitForTimeout(500);
      expect(seen).toEqual([]);
      expect(fake.requests).toEqual([]);
      expect(await page.locator("html").getAttribute("data-supabase-accounts")).toBeNull();
      expect(await page.locator("html").getAttribute("data-supabase-test")).toBeNull();
    });
  }
}

test("flag on but no production config: says so, loads no library and contacts no project", async ({ page, context, baseURL }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await serveAs(context, baseURL, ["swimtics.com"], { overrides: flagOn });
  const seen = recordLoads(page);
  await page.goto("https://swimtics.com/");
  await expect(page.locator("html")).toHaveAttribute("data-supabase-accounts", "no-config");
  await enter(page);
  expect(await cardText(page)).toContain("accounts aren't configured on this site yet");
  expect(seen.filter((u) => /supabase-js|\.supabase\.co|supabase-test-pbs/.test(u))).toEqual([]);
  expect(fake.requests).toEqual([]);
});

for (const [label, config, reason] of [
  ["the test project (while no production project is set)", { url: "https://kcnedhhrjlyuxwapjojv.supabase.co", publishableKey: FAKE_KEY }, "PRODUCTION_PROJECT_REF"],
  ["any project (while no production project is set)", { url: FAKE_URL, publishableKey: FAKE_KEY }, "PRODUCTION_PROJECT_REF"],
  ["a secret key", { url: FAKE_URL, publishableKey: "sb_secret_abc123" }, "must never be used in the website"],
]) {
  test(`flag on with a config for ${label}: refused before any request`, async ({ page, context, baseURL }) => {
    const fake = createFakeSupabase();
    await fake.install(context);
    await serveAs(context, baseURL, ["swimtics.com"], { overrides: flagOn, productionConfig: config });
    const seen = recordLoads(page);
    await page.goto("https://swimtics.com/");
    await expect(page.locator("html")).toHaveAttribute("data-supabase-accounts", "bad-config");
    await enter(page);
    expect(await cardText(page)).toContain(reason);
    expect(seen.filter((u) => /supabase-js|\.supabase\.co|supabase-test-pbs/.test(u))).toEqual([]);
    expect(fake.requests).toEqual([]);
  });
}

test("flag on with a stand-in production ref: the test project is still refused", async ({ page, context, baseURL }) => {
  await serveAs(context, baseURL, ["swimtics.com"], {
    overrides: { ...flagOn, ...fakeProductionRef },
    productionConfig: { url: "https://kcnedhhrjlyuxwapjojv.supabase.co", publishableKey: FAKE_KEY },
  });
  const seen = recordLoads(page);
  await page.goto("https://swimtics.com/");
  await expect(page.locator("html")).toHaveAttribute("data-supabase-accounts", "bad-config");
  await enter(page);
  expect(await cardText(page)).toContain("TEST project");
  expect(seen.filter((u) => /supabase-js|\.supabase\.co/.test(u))).toEqual([]);
});

test("flag on: production mode never starts on local or preview hosts", async ({ page, context, baseURL }) => {
  await serveAs(context, baseURL, [PREVIEW], { overrides: flagOn, productionConfig: { url: FAKE_URL, publishableKey: FAKE_KEY } });
  const seen = recordLoads(page);
  await page.goto(`https://${PREVIEW}/`);
  await enter(page);
  await page.waitForTimeout(500);
  expect(await page.locator("html").getAttribute("data-supabase-accounts")).toBeNull();
  expect(seen.filter((u) => !/supabase-env\.js$/.test(u)), "only the host check is loaded").toEqual([]);

  // locally, with the flag on and ?supabase: test mode only
  const fake = createFakeSupabase();
  await fake.install(context);
  await context.route("**/src/app/data/accounts-flags.js", async (route) => {
    const r = await fetch(`${baseURL}/src/app/data/accounts-flags.js`);
    route.fulfill({ status: 200, contentType: "text/javascript", body: flagOn["/src/app/data/accounts-flags.js"](await r.text()) });
  });
  await page.goto("/?supabase");
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await page.waitForTimeout(300);
  expect(await page.locator("html").getAttribute("data-supabase-accounts")).toBeNull();
  expect(await page.evaluate(() => window.__swimticsSupabaseEnv)).toBe("test");
});

test("flag on (stand-in project): sign-ups are closed; an existing account logs in with production-only keys", async ({ page, context, baseURL }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  const now = new Date().toISOString();
  fake.users.set("invited@example.com", { id: "11111111-1111-4111-8111-111111111111", email: "invited@example.com", password: PASSWORD, confirmedAt: now, createdAt: now });
  await serveAs(context, baseURL, ["swimtics.com"], {
    overrides: { ...flagOn, ...fakeProductionRef },
    productionConfig: { url: FAKE_URL, publishableKey: FAKE_KEY },
  });
  await page.goto("https://swimtics.com/");
  await expect(page.locator("html")).toHaveAttribute("data-supabase-accounts", "ready");
  await enter(page);
  await page.evaluate(() => localStorage.setItem("profile", JSON.stringify({ name: "Device Owner" })));

  await page.locator(".site-nav-signin").click();
  await expect(page.locator("#loginView").getByRole("button", { name: "Sign Up" })).toBeHidden();
  await page.evaluate(() => window.showSignup());
  await expect(page.locator("#signupView")).toBeHidden();
  await expect(page.locator("#authMessage")).toContainText("invite-only");
  await page.evaluate(() => window.signupUser());
  expect(fake.requests.filter((r) => r.path === "/auth/v1/signup")).toEqual([]);

  await page.locator("#authEmail").fill("invited@example.com");
  await page.locator("#authPassword").fill(PASSWORD);
  await page.locator("#loginView").getByRole("button", { name: "Login" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
  expect(await cardText(page)).toContain("Signed in as invited@example.com");
  await expect(page.locator("#testAccountRow")).toContainText("No profile saved to your account yet");
  expect(await cardText(page)).not.toContain("test");

  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys).toContain("swimtics-auth");
  expect(keys).toContain("swimtics:sb:activeUid");
  expect(keys.filter((k) => k.startsWith("swimtics-test"))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("swimtics:sb:guestProfile")))).toEqual({ name: "Device Owner" });
});

test("flag on (stand-in project): production photo sync stays off — no photo module, no Storage request", async ({ page, context, baseURL }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  const now = new Date().toISOString();
  fake.users.set("invited@example.com", { id: "11111111-1111-4111-8111-111111111111", email: "invited@example.com", password: PASSWORD, confirmedAt: now, createdAt: now });
  await serveAs(context, baseURL, ["swimtics.com"], {
    overrides: { ...flagOn, ...fakeProductionRef },
    productionConfig: { url: FAKE_URL, publishableKey: FAKE_KEY },
  });
  const photoModule = [];
  page.on("request", (r) => { if (/supabase-test-photos\.js/.test(r.url())) photoModule.push(r.url()); });
  await page.goto("https://swimtics.com/");
  await expect(page.locator("html")).toHaveAttribute("data-supabase-accounts", "ready");
  await enter(page);
  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill("invited@example.com");
  await page.locator("#authPassword").fill(PASSWORD);
  await page.locator("#loginView").getByRole("button", { name: "Login" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
  expect(await cardText(page)).toContain("Signed in as invited@example.com");
  await expect(page.locator("#testAccountPhoto")).toHaveCount(0);

  await page.evaluate(() => window.showPage("profile"));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#profileImageBox").click()]);
  await chooser.setFiles({ name: "me.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64") });
  await expect(page.locator("#profileImageBox img")).toHaveAttribute("src", /^data:image\/png/);   // unchanged local behaviour
  expect(photoModule).toEqual([]);
  expect(fake.requests.filter((r) => r.path.startsWith("/storage/"))).toEqual([]);
});
/* ---- flag off, with a production account's data still on the device ---- */

/* What an earlier flag-on period would have left: the account's profile
   and PBs in the working copy, the device's own set aside. */
const DEVICE_PROFILE = { name: "Device Owner" };
const DEVICE_PBS = [{ event: "Freestyle 50m", course: "Short Course", time: "30.00", history: [30] }];
const SEEDED = {
  "swimtics:sb:activeUid": "11111111-1111-4111-8111-111111111111",
  "swimtics:sb:guestProfile": JSON.stringify(DEVICE_PROFILE),
  "swimtics:sb:guestPbs": JSON.stringify(DEVICE_PBS),
  profile: JSON.stringify({ name: "Account Holder" }),
  pbs: JSON.stringify([{ event: "Backstroke 50m", course: "Long Course", time: "35.00", history: [35] }]),
};
/* the production modules the entry point could load beyond itself and accounts-flags.js */
const PRODUCTION_MODULES = /supabase-env\.js|supabase-accounts-core\.js|supabase-test-pbs\.js|supabase-production-config\.js|@supabase\/supabase-js|\.supabase\.co/;

const storage = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])));

/* Open `url`, seed the leftover data, then reload and record what loads. */
async function seedAndReload(page, url) {
  await page.goto(url);
  await page.evaluate((seed) => { for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v); }, SEEDED);
  const before = await storage(page);
  const seen = [];
  page.on("request", (r) => { if (PRODUCTION_MODULES.test(r.url())) seen.push(r.url()); });
  const entryLoaded = page.waitForRequest(/production-accounts\.js/);
  await page.reload();
  await entryLoaded;
  await page.waitForTimeout(1000);
  return { before, seen };
}

for (const host of ["localhost", "127.0.0.1", PREVIEW]) {
  test(`flag off, leftover production data on ${host}: no production module loads and storage is untouched`, async ({ page, context, baseURL }) => {
    const fake = createFakeSupabase();
    await fake.install(context);
    await serveAs(context, baseURL, [host], { productionConfig: { url: FAKE_URL, publishableKey: FAKE_KEY } });
    const { before, seen } = await seedAndReload(page, `https://${host}/`);
    expect(seen).toEqual([]);
    expect(await storage(page)).toEqual(before);
    expect(fake.requests).toEqual([]);
  });
}

for (const host of PRODUCTION_HOSTS) {
  test(`flag off, leftover production data on ${host}: the device's own data comes back, nothing is contacted`, async ({ page, context, baseURL }) => {
    const fake = createFakeSupabase();
    await fake.install(context);
    await serveAs(context, baseURL, [host], { productionConfig: { url: FAKE_URL, publishableKey: FAKE_KEY } });
    const { seen } = await seedAndReload(page, `https://${host}/`);
    await expect.poll(() => page.evaluate(() => localStorage.getItem("swimtics:sb:activeUid"))).toBeNull();
    const after = await storage(page);
    expect(JSON.parse(after.profile)).toEqual(DEVICE_PROFILE);
    expect(JSON.parse(after.pbs)).toEqual(DEVICE_PBS);
    expect(Object.keys(after).filter((k) => k.startsWith("swimtics:sb:"))).toEqual([]);
    expect(after["swimtics-auth"], "no auth session was created").toBeUndefined();
    // only the local restore code loaded: no config, PB module, library or project
    expect(seen.filter((u) => !/supabase-env\.js|supabase-accounts-core\.js/.test(u))).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(await page.locator("html").getAttribute("data-supabase-accounts")).toBeNull();
    await enter(page);
    await page.evaluate(() => window.showPage("profile"));
    await expect(page.locator("#name")).toHaveValue("Device Owner");
    expect(await cardText(page)).toContain("Accounts aren't available yet");
  });
}
