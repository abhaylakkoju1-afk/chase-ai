// Supabase test mode: browser storage refuses a write the account code needs
// (quota exceeded, or a general storage error) while saved PBs or a profile
// can't be read. The working copy must never be replaced unless the text it
// holds was preserved first (set aside, or kept as this account's
// unreadable copy, each read back exactly). Instead the sign-in, log-out,
// switch or restore step stops, the original text stays byte for byte,
// nothing reaches the account, and the page says what to do next. If the
// session then ends outside the page (another tab, an expired session), the
// account's data is hidden on the signed-out page instead (accountMask in
// saved-data-check.js), without any storage write.
// Driven through the real page and supabase-js against the in-memory
// stand-in (support/fake-supabase.js); no real project or credentials.

import { test, expect } from "@playwright/test";
import { createFakeSupabase } from "./support/fake-supabase.js";

const ANALYTICS = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
const PASSWORD = "swim-fast-123";
const P = "swimtics-test:";

const DEVICE_BAD_PBS = '[{"event":"Freestyle 50m","course":"Short Course","time":"28.00"';
const ACCOUNT_BAD_PBS = '{"event":"Backstroke 50m","course":"Long Course","time":"35.00"}';
const DEVICE_BAD_PROFILE = '{"name":"Device","club":';

/* localStorage.setItem / removeItem throw for keys matching the rule saved
   in sessionStorage "__refuseWrites" ({ match, kind }), on every page load. */
async function installStorageRefusal(context) {
  await context.addInitScript(() => {
    const proto = Storage.prototype;
    const set = proto.setItem;
    const remove = proto.removeItem;
    const rule = () => { try { return JSON.parse(window.sessionStorage.getItem("__refuseWrites") || "null"); } catch { return null; } };
    function check(storage, key) {
      if (storage !== window.localStorage) return;
      const r = rule();
      if (!r || !new RegExp(r.match).test(key)) return;
      throw r.kind === "quota"
        ? new DOMException("The quota has been exceeded.", "QuotaExceededError")
        : new Error("The operation is insecure.");
    }
    proto.setItem = function (k, v) { check(this, k); return set.call(this, k, v); };
    proto.removeItem = function (k) { check(this, k); return remove.call(this, k); };
  });
}
const refuseWrites = (page, match, kind) => page.evaluate(([m, k]) => sessionStorage.setItem("__refuseWrites", JSON.stringify({ match: m, kind: k })), [match, kind]);
const allowWrites = (page) => page.evaluate(() => sessionStorage.removeItem("__refuseWrites"));

async function enter(page) {
  if (!(await page.locator("#entryGate").isVisible())) return;           // already past the gate
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}
async function ready(page) {
  await expect(page.locator("html")).toHaveAttribute("data-supabase-test", "ready");
}
async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#testAccountRow")).not.toContainText("Loading");
  await expect(page.locator("html")).not.toHaveAttribute("data-pbs-loading");
}
// Sign up from the page already open (so device data can be set first).
async function signUpHere(page, fake, email) {
  await ready(page);
  await enter(page);
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
async function logInWithoutLoading(page, email) {
  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(PASSWORD);
  await page.locator("#loginView").getByRole("button", { name: "Login" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
}
async function logOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([page.waitForEvent("load"), page.locator("button[onclick='logoutUser()']").click()]);
  await ready(page);
  await enter(page);
}
async function reload(page) {
  await page.reload();
  await ready(page);
  await enter(page);
}
// Log Out when browser storage refuses what it needs: no sign-out, no reload.
async function logOutRefused(page) {
  await page.evaluate(() => { window.showPage("profile"); window.__samePage = true; });
  await page.locator("button[onclick='logoutUser()']").click();
  await expect(page.locator("#savedDataStorageAlert")).toBeVisible();
  await settle(page);
  expect(await page.evaluate(() => window.__samePage)).toBe(true);     // the page wasn't reloaded
}
// Still signed in as `uid`, and the page says so (never shown as signed out).
async function stillSignedIn(page, email, uid) {
  const session = JSON.parse((await stored(page, "swimtics-test-auth")) || "null");
  expect(session && session.user && session.user.id).toBe(uid);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#accountDetails")).not.toContainText("not signed in");
  await expect(page.locator(".site-nav-signin")).toHaveText("Account");
  await expect(page.locator("button[onclick='logoutUser()']").first()).toBeVisible();
}
async function addPb(page, event, course, time) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption(event);
  await page.locator("#course").selectOption(course);
  await page.locator("#time").fill(time);
  await page.locator("button[onclick='savePB()']").click();
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your test account.");
}

// A signed-in test account with two PBs, signed up on a device whose own
// data is `device` ({ profile, pbs } raw text, or nothing).
async function accountWithPbs(page, context, email, device = {}) {
  const fake = createFakeSupabase();
  await fake.install(context);
  await page.goto("/?supabase");
  await page.evaluate(({ profile, pbs }) => {
    if (profile !== undefined) localStorage.setItem("profile", profile);
    if (pbs !== undefined) localStorage.setItem("pbs", pbs);
  }, device);
  await signUpHere(page, fake, email);
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");
  await addPb(page, "Backstroke 50m", "Long Course", "35.00");
  const uid = fake.users.get(email).id;
  const remote = fake.pbsOf(uid);
  expect(remote.map((p) => p.event)).toEqual(["Freestyle 50m", "Backstroke 50m"]);
  return { fake, uid, remote, profileRow: structuredClone(fake.profiles.get(uid) ?? null) };
}

const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const copiesOf = (page, uid) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)).sort().map((k) => [k.slice(prefix.length).split(":")[0], localStorage.getItem(k)]),
`${P}unreadableCopy:${uid}:`);
const accountWrites = (fake, from) => fake.requests.slice(from)
  .filter((r) => r.method !== "GET" && /profiles|personal_bests|pb_entries|add_pb_entries|device_imports/.test(r.path))
  .map((r) => `${r.method} ${r.path}`);
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 750)));

const SIGNED_OUT_TITLE = "Your session ended: the account's data is hidden because browser storage is full or blocked";
const NAV = ["Chase", "Wall of Records", "Chronos", "War Room", "Profile"];

// Everything in localStorage except the auth session (which a sign-out elsewhere removes).
const snapshot = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
  .filter((k) => !k.startsWith("swimtics-test-auth")).sort().map((k) => [k, localStorage.getItem(k)])));

// None of `secrets` is on the page as shown: visible text, form values or images.
async function noneShown(page, secrets) {
  const shown = await page.evaluate(() => [document.body.innerText,
    ...[...document.querySelectorAll("input, textarea, select")].map((e) => e.value),
    ...[...document.images].map((i) => i.getAttribute("src") || "")].join("\n"));
  for (const secret of secrets) expect(shown).not.toContain(secret);
}

// Signed out, the account's data hidden: the message says so, and no page
// (reached through the navigation) shows any of it.
async function expectHidden(page, secrets) {
  await expectStorageMessage(page, "signed-out", SIGNED_OUT_TITLE);
  const box = page.locator("#savedDataStorageAlert");
  await expect(box).toContainText("signed out outside this page");
  await expect(box).toContainText("hidden on this page");
  await expect(box).not.toContainText(/Download a backup|may still show|was deleted\./);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
  await expect(page.locator(".site-nav-signin")).toHaveText("Sign In");
  await hiddenOnEveryPage(page, secrets);
}

// No page (reached through the navigation) shows any of the hidden data.
async function hiddenOnEveryPage(page, secrets) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#profileDataRecovery .saved-data-hidden-note")).toBeVisible();
  await expect(page.locator("#profileDataRecovery .saved-data-recovery")).toHaveCount(0);
  await expect(page.locator("#displayName")).toHaveText("Athlete Name");
  await expect(page.locator("#name")).toHaveValue("");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList .saved-data-hidden-note")).toBeVisible();
  await expect(page.locator("#pbList .pb-item, #pbList .saved-data-recovery")).toHaveCount(0);
  for (const name of NAV) {
    const tools = page.locator("#siteNavToolsButton");
    if ((await tools.getAttribute("aria-expanded")) !== "true") await tools.click();
    await expect(page.locator("#siteNavToolsMenu")).toBeVisible();
    await page.locator("#siteNavToolsMenu").getByRole("button", { name, exact: true }).click();
    await noneShown(page, secrets);
  }
  await page.locator("nav.site-nav .site-nav-brand").click();
  await noneShown(page, secrets);
}

// While hidden, nothing can be saved over it: PBs, the profile, the photo
// (signed in as another account, its photo goes to that account instead).
async function nothingSavable(page, { signedIn = false } = {}) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption("Freestyle 50m");
  await page.locator("#course").selectOption("Short Course");
  await page.locator("#time").fill("29.00");
  await page.locator("button[onclick='savePB()']").click();
  await expect(page.locator("#pbBlockedError")).toContainText("belong to an account that isn't signed in, so they're hidden. Nothing was saved.");
  await page.evaluate(() => { window.savePB(); window.deletePB(0); });
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Typed while hidden");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toContainText("Your profile wasn't saved: the profile saved in this browser belongs to an account that isn't signed in");
  await page.evaluate(() => window.saveProfile());
  if (!signedIn) {
    await page.evaluate(() => window.uploadProfileImage());
    await expect(page.locator("#profileSaveStatus")).toContainText("The photo wasn't saved");
  }
  await page.evaluate(() => window.testImportDeviceData && window.testImportDeviceData());
  await page.locator("#name").fill("");
}

async function expectStorageMessage(page, step, title) {
  const box = page.locator("#savedDataStorageAlert");
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("data-step", step);
  await expect(box).toHaveAttribute("role", "alert");
  await expect(box.locator("h4")).toHaveText(title);
  await expect(box).toContainText("Nothing was deleted, but no backup was made either.");
  await expect(box).toContainText("free up browser storage");
  await expect(box).not.toContainText(/was backed up|backup was saved/);
}

test.beforeEach(async ({ context }) => {
  await context.route(ANALYTICS, (r) => r.abort());
  await installStorageRefusal(context);
});

test("signing in when this device's unreadable PBs can't be set aside (quota exceeded): the account isn't loaded, the device text stays exact, nothing is sent", async ({ page, context }) => {
  test.setTimeout(120_000);
  const email = "signin-quota@example.com";
  const { fake, uid, remote, profileRow } = await accountWithPbs(page, context, email);
  await logOut(page);

  const deviceProfile = '{"name":"Device swimmer"}';
  await page.evaluate(([p, b]) => { localStorage.setItem("profile", p); localStorage.setItem("pbs", b); }, [deviceProfile, DEVICE_BAD_PBS]);
  await refuseWrites(page, `^${P}guest`, "quota");
  const from = fake.requests.length;
  await logInWithoutLoading(page, email);
  await settle(page);

  await expectStorageMessage(page, "sign-in", "Your account wasn't loaded: browser storage is full or blocked");
  await expect(page.locator("#testAccountRow")).toHaveText("Your test account wasn't loaded into this page because browser storage is full or blocked. See the message at the top of the page.");
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);
  expect(await stored(page, "profile")).toBe(deviceProfile);
  expect(await stored(page, `${P}activeUid`)).toBeNull();
  expect(await stored(page, `${P}guestPbs`)).toBeNull();

  // nothing reaches the account: not a PB change, not a profile save
  await page.evaluate(() => window.deletePB(0));
  await page.locator("#name").fill("Changed on the held page");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toContainText("Your test account wasn't loaded into this page");
  await settle(page);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(uid)).toEqual(remote);
  expect(fake.profiles.get(uid) ?? null).toEqual(profileRow);
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);

  // once storage accepts writes, a reload loads the account and sets the device text aside exactly
  await allowWrites(page);
  await reload(page);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_BAD_PBS);
  expect(fake.pbsOf(uid)).toEqual(remote);
});

test("reloading while signed in when the account's unreadable PB copy can't be kept (storage error): the text stays exact, the account isn't refreshed or synced", async ({ page, context }) => {
  test.setTimeout(120_000);
  const email = "reload-blocked@example.com";
  const { fake, uid, remote } = await accountWithPbs(page, context, email);

  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  await refuseWrites(page, `^${P}unreadableCopy:`, "error");
  const from = fake.requests.length;
  await reload(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await settle(page);

  await expectStorageMessage(page, "reload", "Your account's data wasn't refreshed: browser storage is full or blocked");
  await expect(page.locator("#savedDataStorageAlert")).toContainText("Your account's personal bests saved in this browser can't be read");
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  expect(await stored(page, `${P}activeUid`)).toBe(uid);
  expect(await copiesOf(page, uid)).toEqual([]);

  await page.evaluate(() => window.deletePB(0));
  await page.evaluate(() => window.savePB());
  await settle(page);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(uid)).toEqual(remote);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  // the PB page still offers a backup of the exact text, and no Start fresh
  await page.evaluate(() => window.showPage("pb"));
  const panel = page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]');
  await expect(panel.getByRole("button", { name: "Download a backup" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Start fresh/ })).toHaveCount(0);

  await allowWrites(page);
  await reload(page);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(fake.pbsOf(uid)).toEqual(remote);
});

test("logging out when the account's unreadable PB copy can't be kept (quota exceeded): you stay signed in, nothing is replaced, sent or shown signed out; Log Out works once storage does", async ({ page, context }) => {
  test.setTimeout(120_000);
  const email = "logout-quota@example.com";
  const { fake, uid, remote, profileRow } = await accountWithPbs(page, context, email, { pbs: DEVICE_BAD_PBS });
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_BAD_PBS);

  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  const accountProfile = await stored(page, "profile");
  await refuseWrites(page, `^${P}unreadableCopy:`, "quota");
  const from = fake.requests.length;
  await logOutRefused(page);

  await expectStorageMessage(page, "sign-out", "You\'re still signed in: logging out didn\'t finish because browser storage is full or blocked");
  await expect(page.locator("#savedDataStorageAlert")).toContainText("then choose Log Out again");
  await expect(page.locator("#savedDataStorageAlert")).not.toContainText("even after logging out");
  await stillSignedIn(page, email, uid);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  expect(await stored(page, "profile")).toBe(accountProfile);
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_BAD_PBS);
  expect(await stored(page, `${P}activeUid`)).toBe(uid);
  expect(await copiesOf(page, uid)).toEqual([]);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(uid)).toEqual(remote);
  expect(fake.profiles.get(uid) ?? null).toEqual(profileRow);

  // storage accepts writes again: Log Out finishes and the recovery copies are right
  await allowWrites(page);
  await logOut(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).not.toContainText("Signed in as");
  expect(await stored(page, "swimtics-test-auth")).toBeNull();
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);
  expect(await stored(page, `${P}guestPbs`)).toBeNull();
  expect(await stored(page, `${P}activeUid`)).toBeNull();
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(uid)).toEqual(remote);
});

test("switching to another account while the previous account's unreadable copy can't be kept: the new account isn't loaded and nothing moves between accounts", async ({ page, context }) => {
  test.setTimeout(150_000);
  const { fake, uid } = await accountWithPbs(page, context, "first@example.com");
  await logOut(page);
  // a second account, then back to the first
  await signUpHere(page, fake, "second@example.com");
  const second = fake.users.get("second@example.com").id;
  await logOut(page);
  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill("first@example.com");
  await page.locator("#authPassword").fill(PASSWORD);
  await page.locator("#loginView").getByRole("button", { name: "Login" }).click();
  await signedInAs(page, "first@example.com");

  // the first account's copy becomes unreadable; its session then ends
  // elsewhere (as when another tab logs out), and start-up can't keep the copy
  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  await refuseWrites(page, `^${P}unreadableCopy:`, "error");
  await page.evaluate(() => localStorage.removeItem("swimtics-test-auth"));
  await reload(page);
  await expectHidden(page, ["30.00", "35.00", "first@example.com"]);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  const from = fake.requests.length;
  await logInWithoutLoading(page, "second@example.com");
  await settle(page);
  await expectStorageMessage(page, "leave", "Switching accounts didn't finish: browser storage is full or blocked");
  await expect(page.locator("#testAccountRow")).toContainText("wasn't loaded into this page");
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  expect(await stored(page, `${P}activeUid`)).toBe(uid);                 // still the first account's
  expect(await copiesOf(page, second)).toEqual([]);                       // never kept for the wrong account
  // the first account's data stays hidden from the second account
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList .saved-data-hidden-note")).toBeVisible();
  await noneShown(page, ["30.00", "35.00"]);
  await nothingSavable(page, { signedIn: true });
  await settle(page);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(second)).toEqual([]);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  // the second account can log out (the first account's data stays hidden)
  await logOut(page);
  await expectHidden(page, ["30.00", "35.00", "first@example.com", "second@example.com"]);
  expect(await stored(page, "swimtics-test-auth")).toBeNull();
  expect(await stored(page, `${P}activeUid`)).toBe(uid);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  await allowWrites(page);
  await reload(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(await copiesOf(page, second)).toEqual([]);
  expect(await stored(page, `${P}activeUid`)).toBeNull();
});

test("putting this device's unreadable profile back fails (storage error): Log Out stops, you stay signed in, and the set-aside text stays exact; Log Out works once storage does", async ({ page, context }) => {
  test.setTimeout(120_000);
  const email = "restore-blocked@example.com";
  const { fake, uid, remote, profileRow } = await accountWithPbs(page, context, email, { profile: DEVICE_BAD_PROFILE });
  expect(await stored(page, `${P}guestProfile`)).toBe(DEVICE_BAD_PROFILE);
  const accountPbs = await stored(page, "pbs");
  const accountProfile = await stored(page, "profile");

  await refuseWrites(page, "^(profile|pbs)$", "error");
  const from = fake.requests.length;
  await logOutRefused(page);

  await expectStorageMessage(page, "sign-out-restore", "You\'re still signed in: logging out didn\'t finish because browser storage is full or blocked");
  await stillSignedIn(page, email, uid);
  expect(await stored(page, `${P}guestProfile`)).toBe(DEVICE_BAD_PROFILE);
  expect(await stored(page, `${P}activeUid`)).toBe(uid);
  expect(await stored(page, "pbs")).toBe(accountPbs);
  expect(await stored(page, "profile")).toBe(accountProfile);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(uid)).toEqual(remote);
  expect(fake.profiles.get(uid) ?? null).toEqual(profileRow);

  await allowWrites(page);
  await logOut(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await stored(page, "swimtics-test-auth")).toBeNull();
  expect(await stored(page, "profile")).toBe(DEVICE_BAD_PROFILE);
  expect(await stored(page, `${P}guestProfile`)).toBeNull();
  expect(await stored(page, `${P}activeUid`)).toBeNull();
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator('#profileDataRecovery .saved-data-recovery[data-saved-key="profile"]')).toBeVisible();
  expect(accountWrites(fake, from)).toEqual([]);
});

test("another tab logs out while browser storage refuses writes (quota exceeded): the account's data is hidden at once, across navigation and reloads; nothing can be saved or sent, the stored text stays exact, and signing in again restores the normal flow", async ({ page, context }) => {
  test.setTimeout(180_000);
  const email = "elsewhere-quota@example.com";
  const DEVICE_PBS = JSON.stringify([{ event: "Butterfly 50m", course: "Long Course", time: "31.00", history: [31] }]);
  const DEVICE_PROFILE = '{"name":"Device swimmer"}';
  const { fake, uid, remote } = await accountWithPbs(page, context, email, { profile: DEVICE_PROFILE, pbs: DEVICE_PBS });
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Account swimmer");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");
  const profileRow = structuredClone(fake.profiles.get(uid));
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Backstroke 50m (Long Course) - 35.00");
  const secrets = ["Account swimmer", "30.00", "35.00", email];

  const before = await snapshot(page);
  expect(before[`${P}activeUid`]).toBe(uid);
  expect(before[`${P}guestPbs`]).toBe(DEVICE_PBS);
  await refuseWrites(page, `^(profile|pbs|strokeData|${P})`, "quota");
  const from = fake.requests.length;

  // another tab of this browser logs out
  const other = await context.newPage();
  await other.goto("/favicon.png");
  await Promise.all([page.waitForEvent("load"), other.evaluate(() => localStorage.removeItem("swimtics-test-auth"))]);
  await other.close();
  await ready(page);
  await enter(page);

  await expectHidden(page, secrets);
  await nothingSavable(page);
  await settle(page);
  expect(await snapshot(page)).toEqual(before);
  expect(accountWrites(fake, from)).toEqual([]);

  // still hidden after reloading
  await reload(page);
  await expectHidden(page, secrets);
  expect(await snapshot(page)).toEqual(before);
  expect(accountWrites(fake, from)).toEqual([]);
  expect(fake.pbsOf(uid)).toEqual(remote);
  expect(fake.profiles.get(uid)).toEqual(profileRow);

  // storage accepts writes again and the same account signs in: its data is
  // shown, this device's own copy is still set aside exactly
  await allowWrites(page);
  await logInWithoutLoading(page, email);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  await expect(page.locator("#name")).toHaveValue("Account swimmer");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Backstroke 50m (Long Course) - 35.00");
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_PBS);
  expect(await stored(page, `${P}guestProfile`)).toBe(DEVICE_PROFILE);

  // and Log Out puts this device's own data back exactly
  await logOut(page);
  expect(await stored(page, "pbs")).toBe(DEVICE_PBS);
  expect(await stored(page, "profile")).toBe(DEVICE_PROFILE);
  expect(await stored(page, `${P}activeUid`)).toBeNull();
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Butterfly 50m (Long Course) - 31.00");
  await noneShown(page, ["Account swimmer", "35.00"]);
  expect(fake.pbsOf(uid)).toEqual(remote);
});

test("the session ends while the page is closed and the account's unreadable PB copy can't be kept (storage error): the reopened page hides it, offers no backup of it, and signing in to the same account once storage works keeps both the account's copy and the device's", async ({ page, context }) => {
  test.setTimeout(150_000);
  const email = "expired-blocked@example.com";
  const { fake, uid, remote } = await accountWithPbs(page, context, email, { pbs: DEVICE_BAD_PBS });
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_BAD_PBS);

  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  await refuseWrites(page, `^${P}unreadableCopy:`, "error");
  // the session is gone (expired, or logged out elsewhere) when the page is opened again
  await page.evaluate(() => localStorage.removeItem("swimtics-test-auth"));
  const before = await snapshot(page);
  const from = fake.requests.length;
  await reload(page);

  await expectHidden(page, ["35.00", "30.00"]);
  await nothingSavable(page);
  await reload(page);
  await expectHidden(page, ["35.00", "30.00"]);
  expect(await snapshot(page)).toEqual(before);
  expect(await copiesOf(page, uid)).toEqual([]);
  expect(accountWrites(fake, from)).toEqual([]);

  await allowWrites(page);
  await logInWithoutLoading(page, email);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_BAD_PBS);
  expect(fake.pbsOf(uid)).toEqual(remote);

  await logOut(page);
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);
  expect(await stored(page, `${P}activeUid`)).toBeNull();
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]')).toBeVisible();   // this device's own text, with its recovery message
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
});


/* ---------- a page where no account code runs (no ?supabase) ---------- */

// Supabase requests, or the Supabase account code starting, on this page.
const SUPABASE_TRAFFIC = /supabase\.co|supabase-js|\/api\/supabase-test-config|supabase-accounts-core\.js|supabase-env\.js|supabase-config\.local\.js/;
function watchTraffic(page) {
  const urls = [];
  page.on("request", (r) => urls.push(r.url()));
  return { supabase: () => urls.filter((u) => SUPABASE_TRAFFIC.test(u)) };
}
async function openPlain(page, path = "/") {
  await page.goto(path);
  await enter(page);
  expect(await page.locator("html").getAttribute("data-supabase-test")).toBeNull();
}
const NOT_HERE_TITLE = "An account's data is hidden on this page";
async function expectNotHereMessage(page) {
  const box = page.locator("#savedDataStorageAlert");
  await expect(box).toBeVisible();
  await expect(box).toHaveAttribute("data-step", "not-here");
  await expect(box).toHaveAttribute("role", "alert");
  await expect(box.locator("h4")).toHaveText(NOT_HERE_TITLE);
  await expect(box).toContainText("can't confirm that account is signed in");
  await expect(box).toContainText("kept in this browser exactly as it was");
  await expect(box).toContainText("Nothing was deleted or sent anywhere, but no backup was made either.");
  await expect(box).not.toContainText(/was backed up|backup was saved|Download a backup|may still show/);
}

test("the signed-out page opened without ?supabase while the test account's marker and data are still stored: its data stays hidden across navigation and reloads, the Supabase account code isn't started and nothing is requested, the stored text stays exact, and signing in through ?supabase restores the normal flow", async ({ page, context }) => {
  test.setTimeout(180_000);
  const email = "not-here@example.com";
  const DEVICE_PBS = JSON.stringify([{ event: "Butterfly 50m", course: "Long Course", time: "31.00", history: [31] }]);
  const DEVICE_PROFILE = '{"name":"Device swimmer"}';
  const { fake, uid, remote } = await accountWithPbs(page, context, email, { profile: DEVICE_PROFILE, pbs: DEVICE_PBS });
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Account swimmer");
  await page.locator("button[onclick='saveProfile()']").click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your test account.");
  const profileRow = structuredClone(fake.profiles.get(uid));
  const secrets = ["Account swimmer", "30.00", "35.00", email];

  // the session ends while no page with the account code is open (storage
  // itself works: the mask doesn't depend on a refused write)
  await page.goto("/favicon.png");
  await page.evaluate(() => localStorage.removeItem("swimtics-test-auth"));
  const before = await snapshot(page);
  expect(before[`${P}activeUid`]).toBe(uid);
  expect(before[`${P}guestPbs`]).toBe(DEVICE_PBS);
  expect(before[`${P}guestProfile`]).toBe(DEVICE_PROFILE);
  expect(before.profile).toContain("Account swimmer");
  const from = fake.requests.length;
  const traffic = watchTraffic(page);

  await openPlain(page);
  await expectNotHereMessage(page);
  await hiddenOnEveryPage(page, secrets);
  await nothingSavable(page);
  await settle(page);
  expect(await snapshot(page)).toEqual(before);

  // still hidden after reloading, and after opening the page afresh
  await page.reload();
  await enter(page);
  await expectNotHereMessage(page);
  await hiddenOnEveryPage(page, secrets);
  await openPlain(page);
  await expectNotHereMessage(page);
  await hiddenOnEveryPage(page, secrets);
  await settle(page);
  expect(await snapshot(page)).toEqual(before);
  expect(traffic.supabase()).toEqual([]);
  expect(fake.requests.length).toBe(from);
  expect(fake.pbsOf(uid)).toEqual(remote);
  expect(fake.profiles.get(uid)).toEqual(profileRow);

  // the same account signs in through its normal flow: its data is shown and
  // this device's own copy is still set aside exactly
  await page.goto("/?supabase");
  await ready(page);
  await enter(page);
  await logInWithoutLoading(page, email);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  await expect(page.locator("#name")).toHaveValue("Account swimmer");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Backstroke 50m (Long Course) - 35.00");
  expect(await stored(page, `${P}guestPbs`)).toBe(DEVICE_PBS);
  expect(await stored(page, `${P}guestProfile`)).toBe(DEVICE_PROFILE);

  // Log Out puts this device's own data back exactly, and the plain page then shows it
  await logOut(page);
  expect(await stored(page, "pbs")).toBe(DEVICE_PBS);
  expect(await stored(page, "profile")).toBe(DEVICE_PROFILE);
  expect(await stored(page, `${P}activeUid`)).toBeNull();
  await openPlain(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Butterfly 50m (Long Course) - 31.00");
  await noneShown(page, ["Account swimmer", "35.00"]);
  expect(fake.pbsOf(uid)).toEqual(remote);
});

test("the production account marker on a page that isn't a production host: its data stays hidden and exactly as stored, with nothing requested", async ({ page }) => {
  const ACCOUNT_PBS = JSON.stringify([{ event: "Freestyle 100m", course: "Long Course", time: "58.40", history: [58.4] }]);
  const ACCOUNT_PROFILE = '{"name":"Production swimmer","club":"Sharks"}';
  const secrets = ["58.40", "Production swimmer", "Sharks"];
  await page.goto("/favicon.png");
  await page.evaluate(([pbs, profile]) => {
    localStorage.setItem("pbs", pbs);
    localStorage.setItem("profile", profile);
    localStorage.setItem("swimtics:sb:activeUid", "prod-user-1");
  }, [ACCOUNT_PBS, ACCOUNT_PROFILE]);
  const before = await snapshot(page);
  const traffic = watchTraffic(page);

  await openPlain(page);
  await expectNotHereMessage(page);
  await hiddenOnEveryPage(page, secrets);
  await nothingSavable(page);
  await page.reload();
  await enter(page);
  await expectNotHereMessage(page);
  await hiddenOnEveryPage(page, secrets);
  await settle(page);
  expect(await snapshot(page)).toEqual(before);
  expect(traffic.supabase()).toEqual([]);
});

test("device-only data with no account marker is shown and saved as before, with no message and nothing requested", async ({ page }) => {
  const DEVICE_PBS = JSON.stringify([{ event: "Butterfly 50m", course: "Long Course", time: "31.00", history: [31] }]);
  await page.goto("/favicon.png");
  await page.evaluate((pbs) => {
    localStorage.setItem("pbs", pbs);
    localStorage.setItem("profile", '{"name":"Device swimmer"}');
  }, DEVICE_PBS);
  const traffic = watchTraffic(page);

  await openPlain(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#name")).toHaveValue("Device swimmer");
  await expect(page.locator(".saved-data-hidden-note")).toHaveCount(0);
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Butterfly 50m (Long Course) - 31.00");
  await page.locator("#event").selectOption("Freestyle 50m");
  await page.locator("#course").selectOption("Short Course");
  await page.locator("#time").fill("29.00");
  await page.locator("button[onclick='savePB()']").click();
  await expect(page.locator("#pbList")).toContainText("Freestyle 50m (Short Course) - 29.00");
  expect(JSON.parse(await stored(page, "pbs")).map((p) => p.time)).toEqual(["31.00", "29.00"]);
  await page.reload();
  await enter(page);
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Freestyle 50m (Short Course) - 29.00");
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(traffic.supabase()).toEqual([]);
});
