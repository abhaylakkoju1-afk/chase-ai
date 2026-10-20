// Supabase test mode (src/app/data/supabase-test-account.js) driven through
// the real page with the real supabase-js client, against an in-memory
// stand-in for the swimtics-test project (support/fake-supabase.js). No real
// Supabase project, credentials or email are involved. Analytics hosts are
// blocked so nothing is sent anywhere.

import { test, expect } from "@playwright/test";
import { createFakeSupabase, FAKE_URL } from "./support/fake-supabase.js";

const ANALYTICS = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
const PASSWORD = "swim-fast-123";

async function enter(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

async function openTestMode(page, path = "/?supabase") {
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
}

async function signUp(page, email, password = PASSWORD) {
  await page.locator(".site-nav-signin").click();
  await page.locator("#loginView").getByRole("button", { name: "Sign Up" }).click();
  await page.locator("#signupEmail").fill(email);
  await page.locator("#signupPassword").fill(password);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.locator("#authMessage")).toContainText("Check your email for a confirmation link");
}

async function logIn(page, email, password = PASSWORD) {
  if (!(await page.locator("#authModal").isVisible())) await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(password);
  await page.locator("#loginView").getByRole("button", { name: "Login" }).click();
}

async function ready(page) {
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
}

/* Logging out reloads the page (so nothing of the account stays in
   memory); wait for that, then enter again. */
async function logOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([
    page.waitForEvent("load"),
    page.locator("button[onclick='logoutUser()']").click(),
  ]);
  await ready(page);
  await enter(page);
}

/* Open the emailed confirmation link (same browser), then enter. */
async function confirmEmail(page, fake, email) {
  await page.goto(fake.lastMail(email, "confirm").link);
  await ready(page);
  await enter(page);
}

async function profileName(page) {
  await page.evaluate(() => window.showPage("profile"));
  return page.locator("#name").inputValue();
}

async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
}

test.beforeEach(async ({ context }) => {
  await context.route(ANALYTICS, (r) => r.abort());
});

test("without ?supabase nothing about Supabase loads, and Firebase's unavailable notice stays", async ({ page }) => {
  const seen = [];
  page.on("request", (r) => { if (/supabase/i.test(r.url()) && !/supabase-test-(account|core)\.js/.test(r.url())) seen.push(r.url()); });
  await page.goto("/");
  await enter(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText("Accounts aren't available yet");
  await page.waitForTimeout(500);
  expect(seen, "no config file, library or project requests").toEqual([]);
  expect(await page.locator("html").getAttribute("data-supabase-test")).toBeNull();
});

test("with ?supabase but no local config, it says so and contacts nothing", async ({ page, context }) => {
  const seen = [];
  page.on("request", (r) => { if (/supabase\.co|supabase-js/.test(r.url())) seen.push(r.url()); });
  await context.route("**/src/app/data/supabase-config.local.js", (r) => r.fulfill({ status: 404, body: "" }));
  await page.goto("/?supabase");
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "no-config");
  await enter(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText("no local test configuration");
  expect(seen).toEqual([]);
});

for (const [label, key] of [["a secret key", "sb_secret_abc123"], ["a service_role key", "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x"]]) {
  test(`a config holding ${label} is refused before any request is made`, async ({ page, context }) => {
    const fake = createFakeSupabase();
    await fake.install(context, { config: { url: FAKE_URL, publishableKey: key } });
    await page.goto("/?supabase");
    await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "bad-config");
    await enter(page);
    await page.evaluate(() => window.showPage("profile"));
    await expect(page.locator("#accountDetails")).toContainText("must never be used in the website");
    expect(fake.requests).toEqual([]);
  });
}

test("sign up, confirm the email, stay signed in across reloads, save own profile, log out", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  const email = "alpha@example.com";
  await openTestMode(page);

  await signUp(page, email);
  // not confirmed yet: login is refused with a clear message
  await logIn(page, email);
  await expect(page.locator("#authMessage")).toHaveText("Please confirm your email first — check your inbox for the link.");
  await page.locator(".close-auth").click();

  // the confirmation link signs the visitor in and is removed from the address bar
  const mail = fake.lastMail(email, "confirm");
  expect(new URL(mail.link).searchParams.has("supabase")).toBe(true);
  await page.goto(mail.link);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await expect(page).toHaveURL(/\/\?supabase$/);
  await enter(page);
  await signedInAs(page, email);
  await expect(page.locator("#profileSaveStatus")).toContainText("Email confirmed");
  await expect(page.locator(".site-nav-signin")).toHaveText("Account");
  await expect(page.locator("#testAccountRow")).toContainText("No profile saved to your test account yet");

  // the session survives a reload
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
  await signedInAs(page, email);

  // save the profile: stored for this user only, sent with the user's token
  await page.locator("#name").fill("Alpha Swimmer");
  await page.locator("#club").fill("Test Club");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");
  const alphaId = fake.users.get(email).id;
  expect(fake.profiles.get(alphaId)).toMatchObject({ user_id: alphaId, name: "Alpha Swimmer", club: "Test Club" });
  expect(fake.profiles.get(alphaId)).not.toHaveProperty("photo");
  const write = fake.requests.find((r) => r.method === "POST" && r.path === "/rest/v1/profiles");
  expect(write.authorization).toMatch(/^Bearer ey/);                     // the user's session token, not the bare key

  // log out: the account is gone from the page and stays gone after a reload
  await logOut(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText("You're not signed in to a test account");
  await expect(page.locator(".site-nav-signin")).toHaveText("Sign In");
  expect(await page.evaluate(() => localStorage.getItem("swimtics-test-auth"))).toBeNull();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText("You're not signed in to a test account");
});

test("a second user can't see the first user's saved profile, and loads only their own", async ({ browser }) => {
  test.setTimeout(90_000);                               // two full sign-ups plus a fresh device (~40 s here, on main too)
  const fake = createFakeSupabase();
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  for (const c of [ctxA, ctxB]) { await c.route(ANALYTICS, (r) => r.abort()); await fake.install(c); }
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  for (const [page, email, name] of [[a, "first@example.com", "First Owner"], [b, "second@example.com", "Second Owner"]]) {
    await openTestMode(page);
    await signUp(page, email);
    await page.goto(fake.lastMail(email, "confirm").link);
    await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
    await enter(page);
    await signedInAs(page, email);
    await page.locator("#name").fill(name);
    await page.locator("button[onclick='saveProfile()']").click();
    await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");
  }

  // B, on a fresh device, loads only B's row
  const fresh = await ctxB.newPage();
  await fresh.goto("/?supabase");
  await expect(fresh.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(fresh);
  await fresh.evaluate(() => window.showPage("profile"));
  await expect(fresh.locator("#testAccountRow")).toContainText("Showing your test account's profile");
  await expect(fresh.locator("#name")).toHaveValue("Second Owner");

  // every profiles request targeted the signed-in token's own user id
  const profileCalls = fake.requests.filter((r) => r.path === "/rest/v1/profiles");
  expect(profileCalls.length).toBeGreaterThan(0);
  for (const call of profileCalls) {
    const owner = fake.tokenOwner(call.authorization);
    expect(owner, "sent with a signed-in user's token").toBeTruthy();
    const target = call.method === "GET" ? new URLSearchParams(call.search).get("user_id") : `eq.${JSON.parse(call.body).user_id}`;
    expect(target).toBe(`eq.${owner}`);
  }
  // and the fake (like the RLS policies) refuses a write for someone else
  const bToken = profileCalls.find((c) => fake.tokenOwner(c.authorization) === fake.users.get("second@example.com").id).authorization;
  const forged = await fresh.evaluate(async ([url, key, auth, otherId]) => {
    const r = await fetch(`${url}/rest/v1/profiles`, { method: "POST", headers: { apikey: key, authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ user_id: otherId, name: "Hijack" }) });
    return r.status;
  }, [FAKE_URL, "sb_publishable_fakeTestKey123", bToken, fake.users.get("first@example.com").id]);
  expect(forged).toBe(403);
  expect(fake.profiles.get(fake.users.get("first@example.com").id).name).toBe("First Owner");
  await ctxA.close(); await ctxB.close();
});

test("password reset: the emailed link opens a set-new-password form; the new password works and the old one doesn't", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  const email = "reset@example.com";
  await openTestMode(page);
  await signUp(page, email);
  await page.goto(fake.lastMail(email, "confirm").link);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(page);
  await logOut(page);

  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill(email);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.locator("#authMessage")).toContainText("If an account exists for that email, a password-reset link has been sent");
  await page.locator(".close-auth").click();

  const mail = fake.lastMail(email, "reset");
  expect(new URL(mail.link).searchParams.get("reset")).toBe("1");
  await page.goto(mail.link);
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await expect(page.locator("#newPasswordView")).toBeVisible();
  await expect(page).toHaveURL(/\/\?supabase$/);
  await page.locator("#newPassword").fill("brand-new-pass-456");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
  await enter(page);

  await logOut(page);
  await logIn(page, email, PASSWORD);
  await expect(page.locator("#authMessage")).toHaveText("Email or password is incorrect.");
  await logIn(page, email, "brand-new-pass-456");
  await expect(page.locator("#authModal")).toBeHidden();
  await signedInAs(page, email);
});

test("the reset message is the same for an email with no account", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill("nobody@example.com");
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await expect(page.locator("#authMessage")).toContainText("If an account exists for that email, a password-reset link has been sent");
  expect(fake.mailbox).toEqual([]);
});

test("logging out in one tab clears the account from another tab", async ({ context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  const email = "tabs@example.com";
  const one = await context.newPage();
  await openTestMode(one);
  await signUp(one, email);
  await one.goto(fake.lastMail(email, "confirm").link);
  await expect(one.locator("html")).toHaveAttribute("data-supabase-test", "ready");
  await enter(one);

  const two = await context.newPage();
  await openTestMode(two);
  await signedInAs(two, email);

  const twoReloaded = two.waitForEvent("load");
  await logOut(one);
  await twoReloaded;                                   // the other tab drops the account too
  await ready(two);
  await enter(two);
  await two.evaluate(() => window.showPage("profile"));
  await expect(two.locator("#accountDetails")).toContainText("You're not signed in to a test account");
});

test("one account's profile is never shown to another account or while signed out", async ({ context }) => {
  test.setTimeout(90_000);                               // several sign-ins and page reloads
  const fake = createFakeSupabase();
  await fake.install(context);
  const page = await context.newPage();

  // this device already has its own (signed-out) profile
  await openTestMode(page);
  await page.evaluate(() => localStorage.setItem("profile", JSON.stringify({ name: "Device Owner", club: "Home Club" })));
  await page.reload();
  await ready(page);
  await enter(page);
  expect(await profileName(page)).toBe("Device Owner");

  // A signs up: the device's profile isn't shown in A's account; A saves a name
  await signUp(page, "a@example.com");
  await confirmEmail(page, fake, "a@example.com");
  await signedInAs(page, "a@example.com");
  await expect(page.locator("#testAccountRow")).toContainText("No profile saved to your test account yet");
  expect(await profileName(page)).toBe("");
  await page.locator("#name").fill("Alpha Secret");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");

  // A logs out: the device's own profile is back; A's name is nowhere
  await logOut(page);
  expect(await profileName(page)).toBe("Device Owner");
  await expect(page.locator("body")).not.toContainText("Alpha Secret");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).name)).toBe("Device Owner");

  // B signs up on the same browser: B sees an empty profile, not A's (B saves nothing)
  await signUp(page, "b@example.com");
  await confirmEmail(page, fake, "b@example.com");
  await signedInAs(page, "b@example.com");
  await expect(page.locator("#testAccountRow")).toContainText("No profile saved to your test account yet");
  expect(await profileName(page)).toBe("");
  await expect(page.locator("body")).not.toContainText("Alpha Secret");

  // B logs out: still the device's profile, still no trace of A
  await logOut(page);
  expect(await profileName(page)).toBe("Device Owner");
  await expect(page.locator("body")).not.toContainText("Alpha Secret");

  // A signs in again: A's own saved profile comes back from A's row
  await logIn(page, "a@example.com");
  await expect(page.locator("#authModal")).toBeHidden();
  await signedInAs(page, "a@example.com");
  await expect(page.locator("#name")).toHaveValue("Alpha Secret");

  // another tab switches this browser to B: this tab drops A and shows B's (empty) profile
  const other = await context.newPage();
  await openTestMode(other);
  const reloaded = page.waitForEvent("load");
  await logOut(other);
  await reloaded;
  await logIn(other, "b@example.com");
  await expect(other.locator("#authModal")).toBeHidden();
  await ready(page);
  await enter(page);
  await page.reload();                                  // pick up B's session in this tab
  await ready(page);
  await enter(page);
  await signedInAs(page, "b@example.com");
  expect(await profileName(page)).toBe("");
  await expect(page.locator("body")).not.toContainText("Alpha Secret");
  await other.close();

  // the page is closed while signed in and the session then ends: on reopening,
  // the device's own profile is shown, not the last account's
  await page.evaluate(() => window.showPage("home"));
  await page.goto("/favicon.png");                      // same origin, app not running
  await page.evaluate(() => localStorage.removeItem("swimtics-test-auth"));
  await page.goto("/?supabase");
  await ready(page);
  await enter(page);
  expect(await profileName(page)).toBe("Device Owner");
  await expect(page.locator("#accountDetails")).toContainText("You're not signed in to a test account");
});
