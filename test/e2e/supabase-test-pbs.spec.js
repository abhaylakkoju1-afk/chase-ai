// Personal bests in Supabase test mode (src/app/data/supabase-test-pbs.js and
// supabase-test-account.js), driven through the real page with the real
// supabase-js client against the in-memory stand-in (support/fake-supabase.js),
// which mirrors supabase/sql/002_personal_bests.sql. No real project,
// credentials or email are involved. Analytics hosts are blocked.

import { test, expect } from "@playwright/test";
import { createFakeSupabase } from "./support/fake-supabase.js";

const ANALYTICS = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
const PASSWORD = "swim-fast-123";

async function enter(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}
async function ready(page) {
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
}
async function openTestMode(page) {
  await page.goto("/?supabase");
  await ready(page);
  await enter(page);
}
async function signUp(page, fake, email) {
  await page.locator(".site-nav-signin").click();
  await page.locator("#loginView").getByRole("button", { name: "Sign Up" }).click();
  await page.locator("#signupEmail").fill(email);
  await page.locator("#signupPassword").fill(PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.locator("#authMessage")).toContainText("Check your email for a confirmation link");
  await page.goto(fake.lastMail(email, "confirm").link);
  await ready(page);
  await enter(page);
  await signedInAs(page, email);
}
async function logIn(page, email) {
  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(PASSWORD);
  await page.locator("#loginView").getByRole("button", { name: "Login" }).click();
  // the actual signed-in (and PBs-loaded) state first; the dialog closes with it
  await signedInAs(page, email);
  await expect(page.locator("#authModal")).toBeHidden();
}
async function logOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([page.waitForEvent("load"), page.locator("button[onclick='logoutUser()']").click()]);
  await ready(page);
  await enter(page);
}
/* Signed in, with the account's profile row AND personal bests loaded. The
   PBs arrive after the profile row, so waiting for the row alone could
   read the PB list in between; <html data-pbs-loading> is present exactly
   while an account's PBs are on their way. */
async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#testAccountRow")).not.toContainText("Loading");
  await expect(page.locator("html")).not.toHaveAttribute("data-pbs-loading");
}
async function addPb(page, event, course, time, { synced = true } = {}) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption(event);
  await page.locator("#course").selectOption(course);
  await page.locator("#time").fill(time);
  await page.locator("button[onclick='savePB()']").click();
  if (synced) await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your test account.");
}
async function pbListText(page) {
  await page.evaluate(() => window.showPage("pb"));
  return page.locator("#pbList").innerText();
}
async function seedDevice(page, data) {
  await page.evaluate((d) => {
    for (const [k, v] of Object.entries(d)) localStorage.setItem(k, JSON.stringify(v));
  }, data);
  await page.reload();
  await ready(page);
  await enter(page);
}

test.beforeEach(async ({ context }) => {
  await context.route(ANALYTICS, (r) => r.abort());
});

test("a PB saved while signed in is kept in the account, reloads, reaches a second device, and swims merge keeping the fastest", async ({ browser }) => {
  test.setTimeout(90_000);
  const fake = createFakeSupabase();
  const one = await browser.newContext();
  const two = await browser.newContext();
  for (const c of [one, two]) { await c.route(ANALYTICS, (r) => r.abort()); await fake.install(c); }
  const a = await one.newPage();
  const b = await two.newPage();
  const email = "pbs@example.com";

  await openTestMode(a);
  await signUp(a, fake, email);
  await addPb(a, "Freestyle 50m", "Short Course", "30.00");
  const uid = fake.users.get(email).id;
  expect(fake.pbsOf(uid)).toEqual([{ event: "Freestyle 50m", course: "Short Course", best_time: "30.00", seconds: [30] }]);

  // reload: the list comes back from the account
  await a.reload();
  await ready(a);
  await enter(a);
  await signedInAs(a, email);
  expect(await pbListText(a)).toContain("30.00");

  // a second device signs in, sees it, and adds a faster swim
  await openTestMode(b);
  await logIn(b, email);
  expect(await pbListText(b)).toContain("30.00");
  await addPb(b, "Freestyle 50m", "Short Course", "29.50");
  expect(fake.pbsOf(uid)[0]).toMatchObject({ best_time: "29.50", seconds: [30, 29.5] });

  // the first device picks it up; the same time swum again is a new swim, not a duplicate
  await a.reload();
  await ready(a);
  await enter(a);
  await signedInAs(a, email);
  expect(await pbListText(a)).toContain("29.50");
  await addPb(a, "Freestyle 50m", "Short Course", "30.00");
  expect(fake.pbsOf(uid)[0]).toMatchObject({ best_time: "29.50", seconds: [30, 29.5, 30] });

  // every PB call was made with this user's own session token
  for (const r of fake.requests.filter((x) => /personal_bests|add_pb_entries/.test(x.path))) {
    expect(fake.tokenOwner(r.authorization)).toBe(uid);
  }
  await one.close(); await two.close();
});

test("deleting a PB removes it from the account", async ({ page, context }) => {
  test.setTimeout(60_000);
  const fake = createFakeSupabase();
  await fake.install(context);
  const email = "delete@example.com";
  await openTestMode(page);
  await signUp(page, fake, email);
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");
  await addPb(page, "Backstroke 50m", "Long Course", "35.00");
  const uid = fake.users.get(email).id;
  expect(fake.pbsOf(uid).length).toBe(2);

  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#pbList button[onclick='deletePB(0)']").click();
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your test account.");
  expect(fake.pbsOf(uid).map((p) => p.event)).toEqual(["Backstroke 50m"]);
  expect(fake.pbEntries.filter((e) => e.user_id === uid).length).toBe(1);   // the deleted PB's swims went with it

  await page.reload();
  await ready(page);
  await enter(page);
  await signedInAs(page, email);
  const list = await pbListText(page);
  expect(list).toContain("35.00");
  expect(list).not.toContain("30.00");
});

test("one account's PBs are never shown to another account or while signed out; the device's own PBs come back", async ({ page, context }) => {
  test.setTimeout(90_000);
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await seedDevice(page, { pbs: [{ event: "Butterfly 100m", course: "Long Course", time: "1:10.00", history: [70] }] });
  expect(await pbListText(page)).toContain("1:10.00");

  await signUp(page, fake, "a@example.com");
  expect(await pbListText(page)).not.toContain("1:10.00");          // the device's PB isn't shown as A's
  await addPb(page, "Freestyle 50m", "Short Course", "28.00");

  await logOut(page);
  let list = await pbListText(page);
  expect(list).toContain("1:10.00");                                 // the device's own PB is back
  expect(list).not.toContain("28.00");                               // A's is gone
  await expect(page.locator("body")).not.toContainText("28.00");

  await signUp(page, fake, "b@example.com");
  list = await pbListText(page);
  expect(list).not.toContain("28.00");
  expect(list).not.toContain("1:10.00");

  await logOut(page);
  expect(await pbListText(page)).toContain("1:10.00");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pbs")).map((p) => p.time))).toEqual(["1:10.00"]);
});

test("first sign-in import: previews the device's data, imports it without overwriting the account, and is never offered twice", async ({ page, context }) => {
  test.setTimeout(90_000);
  const fake = createFakeSupabase();
  await fake.install(context);
  const email = "import@example.com";
  await openTestMode(page);
  await seedDevice(page, {
    profile: { name: "Device Owner", club: "Home Club" },
    pbs: [{ event: "Freestyle 50m", course: "Short Course", time: "31.00", history: [32, 31] }],
  });

  await signUp(page, fake, email);
  const uid = fake.users.get(email).id;
  // the account already has a name of its own before importing
  await page.locator("#name").fill("Account Name");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");
  await page.reload();
  await ready(page);
  await enter(page);
  await signedInAs(page, email);

  const offer = page.locator("#testImportOffer");
  await expect(offer).toContainText("2 PB time(s) for Freestyle 50m (Short Course)");
  await expect(offer).toContainText("1 profile field(s) that are empty in your account (club)");
  expect(fake.pbsOf(uid)).toEqual([]);                                // nothing is imported until asked

  await offer.getByRole("button", { name: "Import into my test account" }).click();
  await expect(page.locator("#profileSaveStatus")).toContainText("Imported into your test account: 2 PB time(s) and 1 profile field(s)");
  expect(fake.pbsOf(uid)).toEqual([{ event: "Freestyle 50m", course: "Short Course", best_time: "31.00", seconds: [32, 31] }]);
  expect(fake.profiles.get(uid)).toMatchObject({ name: "Account Name", club: "Home Club" });   // name kept, club filled
  expect(fake.deviceImports.filter((r) => r.user_id === uid).length).toBe(1);
  await expect(offer).toHaveCount(0);
  expect(await pbListText(page)).toContain("31.00");

  // not offered again on reload or on the next sign-in, and the device keeps its own copy
  await page.reload();
  await ready(page);
  await enter(page);
  await signedInAs(page, email);
  await expect(page.locator("#testImportOffer")).toHaveCount(0);
  await logOut(page);
  expect(await page.locator("#name").inputValue()).toBe("Device Owner");
  expect(await pbListText(page)).toContain("31.00");
  await logIn(page, email);
  await expect(page.locator("#testImportOffer")).toHaveCount(0);
  expect(fake.pbsOf(uid)[0].seconds).toEqual([32, 31]);               // no duplicate swims
});

test("\"Not now\" hides the import offer for this account on this device and changes nothing", async ({ page, context }) => {
  test.setTimeout(60_000);
  const fake = createFakeSupabase();
  await fake.install(context);
  const email = "notnow@example.com";
  await openTestMode(page);
  await seedDevice(page, { pbs: [{ event: "Backstroke 100m", course: "Long Course", time: "1:05.00", history: [65] }] });
  await signUp(page, fake, email);
  const uid = fake.users.get(email).id;

  await page.locator("#testImportOffer").getByRole("button", { name: "Not now" }).click();
  await expect(page.locator("#testImportOffer")).toHaveCount(0);
  await page.reload();
  await ready(page);
  await enter(page);
  await signedInAs(page, email);
  await expect(page.locator("#testImportOffer")).toHaveCount(0);
  expect(fake.pbsOf(uid)).toEqual([]);
  expect(fake.deviceImports).toEqual([]);
  await logOut(page);
  expect(await pbListText(page)).toContain("1:05.00");
});

test("signed out, PB changes stay on this device and nothing is sent", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await addPb(page, "IM 200m", "Short Course", "2:30.00", { synced: false });
  expect(await pbListText(page)).toContain("2:30.00");
  await page.waitForTimeout(500);
  expect(fake.requests.filter((r) => /personal_bests|add_pb_entries|device_imports/.test(r.path))).toEqual([]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("pbs"))[0].time)).toBe("2:30.00");
});

test("while a signed-in account's PBs are loading, the list doesn't claim there are none", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await signUp(page, fake, "loading@example.com");
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");

  // hold the account's PB request on the next load
  let release;
  const held = new Promise((r) => { release = r; });
  await context.route("https://fake-swimtics-test.supabase.co/rest/v1/personal_bests*", async (route) => {
    if (route.request().method() === "GET") await held;
    await route.fallback();
  });
  await page.reload();
  await ready(page);
  await enter(page);
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("html")).toHaveAttribute("data-pbs-loading", "true");
  await expect(page.locator("#pbList")).toBeEmpty();
  await expect(page.locator("#pbEmpty")).toBeHidden();               // not "No personal bests yet"

  release();
  await expect(page.locator("html")).not.toHaveAttribute("data-pbs-loading");
  await expect(page.locator("#pbList")).toContainText("30.00");
  await expect(page.locator("#pbEmpty")).toBeHidden();
});

test("a signed-in account with no PBs shows the empty state once its PBs have loaded", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await signUp(page, fake, "nopbs@example.com");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("html")).not.toHaveAttribute("data-pbs-loading");
  await expect(page.locator("#pbEmpty")).toBeVisible();
  await expect(page.locator("#pbEmpty")).toContainText("No personal bests yet");
});
