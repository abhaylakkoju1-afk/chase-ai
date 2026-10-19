// Supabase test mode on Vercel PREVIEW hosts. The app is loaded under real
// hostnames (a swimtics-web preview URL, swimtics.com, the public
// swimtics-web.vercel.app alias) by serving this checkout's files through a
// Playwright route; the preview config endpoint (/api/supabase-test-config)
// is stubbed per test, and Supabase itself is the in-memory stand-in from
// support/fake-supabase.js. Nothing real is contacted.

import { test, expect } from "@playwright/test";
import { createFakeSupabase, FAKE_URL, FAKE_KEY } from "./support/fake-supabase.js";

const PREVIEW = "swimtics-web-git-feat-supabase-auth-test-swim-tics.vercel.app";
const PRODUCTION_HOSTS = ["swimtics.com", "www.swimtics.com", "swimtics-web.vercel.app"];
const ANALYTICS = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
const PASSWORD = "swim-fast-123";

/* Serve this checkout's files for the given hosts; answer the preview
   config endpoint with `api` ({ status, body }) and record every call. */
async function serveAs(context, baseURL, hosts, api = { status: 404, body: { error: "not available" } }) {
  const calls = { api: 0, library: 0 };
  const hostPattern = new RegExp(`^https://(${hosts.map((h) => h.replace(/\./g, "\\.")).join("|")})/`);
  await context.route(ANALYTICS, (r) => r.abort());
  await context.route(/@supabase\/supabase-js/, (r) => { calls.library += 1; r.continue(); });
  await context.route(hostPattern, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === "/api/supabase-test-config") {
      calls.api += 1;
      return route.fulfill({ status: api.status, contentType: "application/json", body: JSON.stringify(api.body) });
    }
    const r = await fetch(`${baseURL}${u.pathname}`);
    return route.fulfill({
      status: r.status,
      headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" },
      body: Buffer.from(await r.arrayBuffer()),
    });
  });
  return calls;
}

async function enter(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

async function cardText(page) {
  await page.evaluate(() => window.showPage("profile"));
  return page.locator("#accountDetails").innerText();
}

for (const host of PRODUCTION_HOSTS) {
  test(`on ${host}, ?supabase does nothing: no config request, no library, Firebase's notice stays`, async ({ page, context, baseURL }) => {
    const fake = createFakeSupabase();
    await fake.install(context);
    const calls = await serveAs(context, baseURL, [host], { status: 200, body: { url: FAKE_URL, publishableKey: FAKE_KEY } });
    await page.goto(`https://${host}/?supabase`);
    await enter(page);
    expect(await cardText(page)).toContain("Accounts aren't available yet");
    await page.waitForTimeout(500);
    expect(await page.locator("html").getAttribute("data-supabase-test")).toBeNull();
    expect(calls).toEqual({ api: 0, library: 0 });
    expect(fake.requests).toEqual([]);
  });
}

test("on a preview URL without ?supabase nothing about Supabase loads", async ({ page, context, baseURL }) => {
  const calls = await serveAs(context, baseURL, [PREVIEW], { status: 200, body: { url: FAKE_URL, publishableKey: FAKE_KEY } });
  await page.goto(`https://${PREVIEW}/`);
  await enter(page);
  await page.waitForTimeout(500);
  expect(await page.locator("html").getAttribute("data-supabase-test")).toBeNull();
  expect(calls).toEqual({ api: 0, library: 0 });
});

test("on a preview URL with no Preview variables set, it says how to configure them and loads nothing", async ({ page, context, baseURL }) => {
  const calls = await serveAs(context, baseURL, [PREVIEW], { status: 404, body: { error: "Supabase test mode is not configured for previews." } });
  await page.goto(`https://${PREVIEW}/?supabase`);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "no-config");
  await enter(page);
  expect(await cardText(page)).toContain("Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY for the Preview environment in Vercel");
  expect(calls).toEqual({ api: 1, library: 0 });
});

test("on a preview URL a refused config (e.g. a secret key) is reported and nothing loads", async ({ page, context, baseURL }) => {
  const calls = await serveAs(context, baseURL, [PREVIEW], {
    status: 500,
    body: { error: "Preview Supabase configuration refused: That is a SECRET key. Use the publishable key (sb_publishable_…); a secret key must never be used in the website." },
  });
  await page.goto(`https://${PREVIEW}/?supabase`);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "bad-config");
  await enter(page);
  expect(await cardText(page)).toContain("must never be used in the website");
  expect(calls.library).toBe(0);
});

test("on a preview URL the page itself also refuses a secret key the endpoint returned by mistake", async ({ page, context, baseURL }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  const calls = await serveAs(context, baseURL, [PREVIEW], { status: 200, body: { url: FAKE_URL, publishableKey: "sb_secret_leaked123" } });
  await page.goto(`https://${PREVIEW}/?supabase`);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "bad-config");
  await enter(page);
  expect(await cardText(page)).toContain("SECRET key");
  expect(calls.library).toBe(0);
  expect(fake.requests).toEqual([]);
});

test("on a preview URL with a valid config: sign up, confirm via a link back to the preview, log in, save, log out", async ({ page, context, baseURL }) => {
  test.setTimeout(60_000);
  const fake = createFakeSupabase();
  await fake.install(context);
  await serveAs(context, baseURL, [PREVIEW], { status: 200, body: { url: FAKE_URL, publishableKey: FAKE_KEY } });
  const email = "preview@example.com";

  await page.goto(`https://${PREVIEW}/?supabase`);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
  await page.locator(".site-nav-signin").click();
  await page.locator("#loginView").getByRole("button", { name: "Sign Up" }).click();
  await page.locator("#signupEmail").fill(email);
  await page.locator("#signupPassword").fill(PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.locator("#authMessage")).toContainText("Check your email for a confirmation link");

  // the emailed link returns to this preview URL (this is what the Supabase redirect allow-list must permit)
  const link = new URL(fake.lastMail(email, "confirm").link);
  expect(link.origin).toBe(`https://${PREVIEW}`);
  expect(link.searchParams.has("supabase")).toBe(true);
  await page.goto(link.toString());
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
  expect(await cardText(page)).toContain(`Signed in as ${email}`);

  await page.locator("#name").fill("Preview Tester");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");
  expect(fake.profiles.get(fake.users.get(email).id).name).toBe("Preview Tester");

  await Promise.all([page.waitForEvent("load"), page.locator("button[onclick='logoutUser()']").click()]);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
  expect(await cardText(page)).toContain("You're not signed in to a test account");
  await expect(page.locator("body")).not.toContainText("Preview Tester");
});
