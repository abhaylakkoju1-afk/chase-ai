// Firebase accounts (account.js), in the real page against the Auth +
// Database emulators (demo-swimtics): browser storage refuses a write the
// account code needs (quota exceeded, or a general storage error) while
// saved PBs or a profile can't be read. Run: npm run test:e2e:emulator
//
// The working copy is never replaced unless the text it holds was preserved
// first (this device's data set aside, or this account's unreadable copy
// kept, each read back exactly). Otherwise the sign-in, log-out, switch or
// restore step stops, the original text stays byte for byte, nothing is
// sent to the account, and the page says what to do next. If the session
// then ends outside the page (another tab, an expired session), the
// account's data is hidden on the signed-out page instead (accountMask in
// saved-data-check.js), without any storage write.
import { test, expect } from "@playwright/test";

const PROJECT = "demo-swimtics";
const AUTH = "http://127.0.0.1:9099";
const DB = "http://127.0.0.1:9000";
const NS = `${PROJECT}-default-rtdb`;
const APP = "/index.html?emulator";
const PASSWORD = "swim-fast-123";

const DEVICE_BAD_PBS = '[{"event":"Freestyle 50m","course":"Short Course","time":"28.00"';
const ACCOUNT_BAD_PBS = '{"event":"Backstroke 50m","course":"Long Course","time":"35.00"}';
const DEVICE_BAD_PROFILE = '{"name":"Device","club":';

async function resetEmulators() {
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  await fetch(`${DB}/.json?ns=${NS}`, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
}
async function readDb(path) {
  const res = await fetch(`${DB}/${path}.json?ns=${NS}`, { headers: { Authorization: "Bearer owner" } });
  return res.json();
}

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
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}
async function signUp(page, email) {
  await page.locator(".site-nav-signin").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator(".auth-switch .auth-link", { hasText: "Sign Up" }).click();
  await page.locator("#signupEmail").fill(email);
  await page.locator("#signupPassword").fill(PASSWORD);
  await page.locator("#signupView button", { hasText: "Create Account" }).click();
}
async function signIn(page, email) {
  await page.locator(".site-nav-signin").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(PASSWORD);
  await page.locator("#loginView button", { hasText: "Login" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
}
async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#accountDetails")).toContainText("Your profile details and personal bests are saved to your account.");
}
async function heldAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#accountDetails")).toContainText("Your account wasn't loaded into this page because browser storage is full or blocked. See the message at the top of the page.");
}
async function signOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([page.waitForEvent("load"), page.locator('button[onclick="logoutUser()"]').click()]);
  await enter(page);
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
}
async function reload(page) {
  await page.reload();
  await enter(page);
}
// Log Out when browser storage refuses what it needs: no sign-out, no reload.
async function signOutRefused(page) {
  await page.evaluate(() => { window.showPage("profile"); window.__samePage = true; });
  await page.locator('button[onclick="logoutUser()"]').click();
  await expect(page.locator("#savedDataStorageAlert")).toBeVisible();
  await settle(page);
  expect(await page.evaluate(() => window.__samePage)).toBe(true);     // the page wasn't reloaded
}
// Still signed in as `uid`, and the page says so (never shown as signed out).
async function stillSignedIn(page, email, uid) {
  expect(await page.evaluate(() => window.auth.currentUser && window.auth.currentUser.uid)).toBe(uid);
  await signedInAs(page, email);
  await expect(page.locator("#accountDetails")).not.toContainText("not signed in");
  await expect(page.locator(".site-nav-signin")).toHaveText("Account");
  await expect(page.locator('button[onclick="logoutUser()"]').first()).toBeVisible();
}
async function addPb(page, event, course, time) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption(event);
  await page.locator("#course").selectOption(course);
  await page.locator("#time").fill(time);
  await page.locator('button[onclick="savePB()"]').click();
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your account.");
}

const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const activeOf = async (page) => JSON.parse((await stored(page, "swimtics:activeUid")) || "null");   // account.js stores it as JSON
const uidOf = (page) => page.evaluate(() => window.auth.currentUser.uid);
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 750)));
const copiesOf = (page, uid) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)).sort().map((k) => [k.slice(prefix.length).split(":")[0], localStorage.getItem(k)]),
`swimtics:unreadableCopy:${uid}:`);
const pbsInAccount = async (uid) => Object.values((await readDb(`users/${uid}/pbs`)) || {})
  .map((p) => `${p.event} (${p.course}) ${p.time}`).sort();

// A signed-in account with two PBs, signed up on a device whose own data is
// `device` ({ profile, pbs } raw text, or nothing).
async function accountWithPbs(page, email, device = {}) {
  await page.goto(APP);
  await page.evaluate(({ profile, pbs }) => {
    localStorage.clear();
    if (profile !== undefined) localStorage.setItem("profile", profile);
    if (pbs !== undefined) localStorage.setItem("pbs", pbs);
  }, device);
  await page.reload();
  await enter(page);
  await signUp(page, email);
  await signedInAs(page, email);
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");
  await addPb(page, "Backstroke 50m", "Long Course", "35.00");
  const uid = await uidOf(page);
  const remote = await pbsInAccount(uid);
  expect(remote).toEqual(["Backstroke 50m (Long Course) 35.00", "Freestyle 50m (Short Course) 30.00"]);
  return { uid, remote, profile: await readDb(`users/${uid}/profile`) };
}

const SIGNED_OUT_TITLE = "Your session ended: the account's data is hidden because browser storage is full or blocked";
const NAV = ["Chase", "Wall of Records", "Chronos", "War Room", "Profile"];

// Everything in localStorage except Firebase's own session keys (a sign-out removes them).
const snapshot = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage)
  .filter((k) => !k.startsWith("firebase:")).sort().map((k) => [k, localStorage.getItem(k)])));

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

// While hidden, nothing can be saved over it: PBs, the profile, the photo.
async function nothingSavable(page, uid) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption("Freestyle 50m");
  await page.locator("#course").selectOption("Short Course");
  await page.locator("#time").fill("29.00");
  await page.locator('button[onclick="savePB()"]').click();
  await expect(page.locator("#pbBlockedError")).toContainText("belong to an account that isn't signed in, so they're hidden. Nothing was saved.");
  await page.evaluate((u) => { window.savePB(); window.deletePB(0); window.saveUserData(u); }, uid);
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Typed while hidden");
  await page.locator('button[onclick="saveProfile()"]').click();
  await expect(page.locator("#profileSaveStatus")).toContainText("Your profile wasn't saved: the profile saved in this browser belongs to an account that isn't signed in");
  await page.evaluate(() => window.saveProfile());
  await expect(page.locator("#profileSaveStatus")).toContainText("Your profile wasn't saved: the profile saved in this browser belongs to an account that isn't signed in");
  await page.evaluate(() => window.uploadProfileImage());
  await expect(page.locator("#profileSaveStatus")).toContainText("The photo wasn't saved");
  await page.evaluate(() => window.offerDeviceImport && window.offerDeviceImport());
  await expect(page.locator("#importDialog")).toHaveCount(0);
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
  await resetEmulators();
  await installStorageRefusal(context);
});

test("signing in when this device's unreadable PBs can't be set aside (quota exceeded): the account isn't loaded, the device text stays exact, nothing is sent", async ({ page }) => {
  const email = "signin-quota@example.com";
  const { uid, remote, profile } = await accountWithPbs(page, email);
  await signOut(page);

  const deviceProfile = '{"name":"Device swimmer"}';
  await page.evaluate(([p, b]) => { localStorage.setItem("profile", p); localStorage.setItem("pbs", b); }, [deviceProfile, DEVICE_BAD_PBS]);
  await refuseWrites(page, "^swimtics:guest:", "quota");
  await signIn(page, email);
  await heldAs(page, email);

  await expectStorageMessage(page, "sign-in", "Your account wasn't loaded: browser storage is full or blocked");
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);
  expect(await stored(page, "profile")).toBe(deviceProfile);
  expect(await activeOf(page)).toBeNull();

  // nothing reaches the account
  await page.evaluate(() => window.deletePB(0));
  await page.evaluate((u) => window.saveUserData(u), uid);
  await page.locator("#name").fill("Changed on the held page");
  await page.evaluate(() => window.saveProfile());
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved on this device only — your account data hasn't loaded.");
  await settle(page);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profile);
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);

  // logging out puts nothing over the device's own data (it was never replaced)
  await signOut(page);
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);

  // once storage accepts writes, signing in sets the device text aside exactly
  await allowWrites(page);
  await signIn(page, email);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await stored(page, "swimtics:guest:pbs")).toBe(DEVICE_BAD_PBS);
  expect(await pbsInAccount(uid)).toEqual(remote);
});

test("reloading while signed in when the account's unreadable PB copy can't be kept (storage error): the text stays exact and the account isn't refreshed or synced", async ({ page }) => {
  const email = "reload-blocked@example.com";
  const { uid, remote } = await accountWithPbs(page, email);

  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  await refuseWrites(page, "^swimtics:unreadableCopy:", "error");
  await reload(page);
  await heldAs(page, email);
  await settle(page);

  await expectStorageMessage(page, "reload", "Your account's data wasn't refreshed: browser storage is full or blocked");
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  expect(await activeOf(page)).toBe(uid);
  expect(await copiesOf(page, uid)).toEqual([]);

  await page.evaluate(() => window.deletePB(0));
  await page.evaluate((u) => window.saveUserData(u), uid);
  await settle(page);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  await page.evaluate(() => window.showPage("pb"));
  const panel = page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]');
  await expect(panel.getByRole("button", { name: "Download a backup" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Start fresh/ })).toHaveCount(0);

  await allowWrites(page);
  await reload(page);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(await pbsInAccount(uid)).toEqual(remote);
});

test("signing out when the account's unreadable PB copy can't be kept (quota exceeded): you stay signed in, nothing is replaced, sent or shown signed out; Log Out works once storage does", async ({ page }) => {
  const email = "signout-quota@example.com";
  const { uid, remote, profile } = await accountWithPbs(page, email, { pbs: DEVICE_BAD_PBS });
  expect(await stored(page, "swimtics:guest:pbs")).toBe(DEVICE_BAD_PBS);

  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  const accountProfile = await stored(page, "profile");
  await refuseWrites(page, "^swimtics:unreadableCopy:", "quota");
  await signOutRefused(page);

  await expectStorageMessage(page, "sign-out", "You\'re still signed in: logging out didn\'t finish because browser storage is full or blocked");
  await expect(page.locator("#savedDataStorageAlert")).toContainText("then choose Log Out again");
  await expect(page.locator("#savedDataStorageAlert")).not.toContainText("even after logging out");
  await stillSignedIn(page, email, uid);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  expect(await stored(page, "profile")).toBe(accountProfile);
  expect(await stored(page, "swimtics:guest:pbs")).toBe(DEVICE_BAD_PBS);
  expect(await activeOf(page)).toBe(uid);
  expect(await copiesOf(page, uid)).toEqual([]);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profile);

  // storage accepts writes again: Log Out finishes and the recovery copies are right
  await allowWrites(page);
  await signOut(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await page.evaluate(() => window.auth.currentUser)).toBeNull();
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);
  expect(await activeOf(page)).toBeNull();
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profile);
});

test("switching to another account while the previous account's unreadable copy can't be kept: the new account isn't loaded and nothing moves between accounts", async ({ page }) => {
  test.setTimeout(120_000);
  const { uid } = await accountWithPbs(page, "first@example.com");
  await signOut(page);
  await signUp(page, "second@example.com");
  await signedInAs(page, "second@example.com");
  const second = await uidOf(page);
  await signOut(page);
  await signIn(page, "first@example.com");
  await signedInAs(page, "first@example.com");

  // the session then ends elsewhere (not this tab's Log Out, e.g. another
  // tab or an expired session), and the copy can't be kept
  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  await refuseWrites(page, "^swimtics:unreadableCopy:", "error");
  await Promise.all([page.waitForEvent("load"), page.evaluate(() => window.auth.signOut())]);
  await enter(page);
  await expectHidden(page, ["30.00", "35.00", "first@example.com"]);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  await signIn(page, "second@example.com");
  await heldAs(page, "second@example.com");
  await settle(page);
  await expectStorageMessage(page, "leave", "Switching accounts didn't finish: browser storage is full or blocked");
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);
  expect(await activeOf(page)).toBe(uid);             // still the first account's
  expect(await copiesOf(page, second)).toEqual([]);                        // never kept for the wrong account
  // the first account's data stays hidden from the second account
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList .saved-data-hidden-note")).toBeVisible();
  await noneShown(page, ["30.00", "35.00"]);
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Typed by the second account");
  await page.evaluate(() => window.saveProfile());
  await expect(page.locator("#profileSaveStatus")).toContainText("Your profile wasn't saved: the profile saved in this browser belongs to an account that isn't signed in");
  await settle(page);
  expect(await readDb(`users/${second}/pbs`)).toBeNull();
  expect(await readDb(`users/${second}/profile`)).toBeNull();
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  // the second account can log out (the first account's data stays hidden)
  await signOut(page);
  await expectHidden(page, ["30.00", "35.00", "first@example.com", "second@example.com"]);
  expect(await page.evaluate(() => window.auth.currentUser)).toBeNull();
  expect(await activeOf(page)).toBe(uid);
  expect(await stored(page, "pbs")).toBe(ACCOUNT_BAD_PBS);

  await allowWrites(page);
  await reload(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(await copiesOf(page, second)).toEqual([]);
  expect(await activeOf(page)).toBeNull();
});

test("putting this device's unreadable profile back fails (storage error): Log Out stops, you stay signed in, and the set-aside text stays exact; Log Out works once storage does", async ({ page }) => {
  const email = "restore-blocked@example.com";
  const { uid, remote, profile } = await accountWithPbs(page, email, { profile: DEVICE_BAD_PROFILE });
  expect(await stored(page, "swimtics:guest:profile")).toBe(DEVICE_BAD_PROFILE);
  const accountPbs = await stored(page, "pbs");
  const accountProfile = await stored(page, "profile");

  await refuseWrites(page, "^(profile|pbs)$", "error");
  await signOutRefused(page);

  await expectStorageMessage(page, "sign-out-restore", "You\'re still signed in: logging out didn\'t finish because browser storage is full or blocked");
  await stillSignedIn(page, email, uid);
  expect(await stored(page, "swimtics:guest:profile")).toBe(DEVICE_BAD_PROFILE);
  expect(await activeOf(page)).toBe(uid);
  expect(await stored(page, "pbs")).toBe(accountPbs);
  expect(await stored(page, "profile")).toBe(accountProfile);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profile);

  await allowWrites(page);
  await signOut(page);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await page.evaluate(() => window.auth.currentUser)).toBeNull();
  expect(await stored(page, "profile")).toBe(DEVICE_BAD_PROFILE);
  expect(await activeOf(page)).toBeNull();
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator('#profileDataRecovery .saved-data-recovery[data-saved-key="profile"]')).toBeVisible();
  expect(await pbsInAccount(uid)).toEqual(remote);
});

test("the session ends outside this page while browser storage refuses writes (quota exceeded): the account's data is hidden at once, across navigation and reloads; nothing can be saved or sent, the stored text stays exact, and signing in again restores the normal flow", async ({ page }) => {
  test.setTimeout(120_000);
  const email = "elsewhere-quota@example.com";
  const DEVICE_PBS = JSON.stringify([{ event: "Butterfly 50m", course: "Long Course", time: "31.00", history: [31] }]);
  const DEVICE_PROFILE = '{"name":"Device swimmer"}';
  await page.goto(APP);
  await page.evaluate(([p, b]) => { localStorage.clear(); localStorage.setItem("profile", p); localStorage.setItem("pbs", b); }, [DEVICE_PROFILE, DEVICE_PBS]);
  await page.reload();
  await enter(page);
  await signUp(page, email);
  await page.locator("#importLater").click();                   // the offer to import this device's data
  await signedInAs(page, email);
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");
  await addPb(page, "Backstroke 50m", "Long Course", "35.00");
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Account swimmer");
  await page.locator('button[onclick="saveProfile()"]').click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your account.");
  const uid = await uidOf(page);
  const remote = await pbsInAccount(uid);
  const profile = await readDb(`users/${uid}/profile`);
  const secrets = ["Account swimmer", "30.00", "35.00", email];

  const before = await snapshot(page);
  expect(JSON.parse(before["swimtics:activeUid"])).toBe(uid);
  expect(before["swimtics:guest:pbs"]).toBe(DEVICE_PBS);
  await refuseWrites(page, "^(profile|pbs|strokeData|swimtics:)", "quota");

  // the session ends outside this page's Log Out (as when another tab logs
  // out or the session expires): hidden at once, before the page reloads
  const [, during] = await Promise.all([page.waitForEvent("load"), page.evaluate(async () => {
    await window.auth.signOut();
    await new Promise((r) => setTimeout(r, 150));
    return {
      pbs: document.getElementById("pbList").innerText,
      name: document.getElementById("name").value,
      shownName: document.getElementById("displayName").innerText,
      cards: document.getElementById("strokeCards").innerText,
    };
  })]);
  expect(during.pbs).not.toContain("30.00");
  expect(during.name).toBe("");
  expect(during.shownName).toBe("Athlete Name");
  expect(during.cards).not.toContain("30.00");
  await enter(page);

  await expectHidden(page, secrets);
  await nothingSavable(page, uid);
  await settle(page);
  expect(await snapshot(page)).toEqual(before);

  // still hidden after reloading
  await reload(page);
  await expectHidden(page, secrets);
  expect(await snapshot(page)).toEqual(before);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profile);

  // storage accepts writes again and the same account signs in: its data is
  // shown, this device's own copy is still set aside exactly
  await allowWrites(page);
  await signIn(page, email);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  await expect(page.locator("#name")).toHaveValue("Account swimmer");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Backstroke 50m (Long Course) - 35.00");
  expect(await stored(page, "swimtics:guest:pbs")).toBe(DEVICE_PBS);
  expect(await stored(page, "swimtics:guest:profile")).toBe(DEVICE_PROFILE);

  // and Log Out puts this device's own data back exactly
  await signOut(page);
  expect(await stored(page, "pbs")).toBe(DEVICE_PBS);
  expect(await stored(page, "profile")).toBe(DEVICE_PROFILE);
  expect(await activeOf(page)).toBeNull();
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("Butterfly 50m (Long Course) - 31.00");
  await noneShown(page, ["Account swimmer", "35.00"]);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profile);
});

test("the session ends while the page is closed and the account's unreadable PB copy can't be kept (storage error): the reopened page hides it, offers no backup of it, and signing in to the same account once storage works keeps both the account's copy and the device's", async ({ page }) => {
  test.setTimeout(120_000);
  const email = "expired-blocked@example.com";
  const { uid, remote } = await accountWithPbs(page, email, { pbs: DEVICE_BAD_PBS });
  expect(await stored(page, "swimtics:guest:pbs")).toBe(DEVICE_BAD_PBS);

  await page.evaluate((v) => localStorage.setItem("pbs", v), ACCOUNT_BAD_PBS);
  await refuseWrites(page, "^swimtics:unreadableCopy:", "error");
  // the session is gone when the page is opened again (Firebase keeps it in localStorage)
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("firebase:authUser:")) localStorage.removeItem(k); });
  const before = await snapshot(page);
  await reload(page);

  await expectHidden(page, ["35.00", "30.00"]);
  await nothingSavable(page, uid);
  await reload(page);
  await expectHidden(page, ["35.00", "30.00"]);
  expect(await snapshot(page)).toEqual(before);
  expect(await copiesOf(page, uid)).toEqual([]);
  expect(await pbsInAccount(uid)).toEqual(remote);

  await allowWrites(page);
  await signIn(page, email);
  await signedInAs(page, email);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
  expect(await stored(page, "swimtics:guest:pbs")).toBe(DEVICE_BAD_PBS);
  expect(await pbsInAccount(uid)).toEqual(remote);

  await signOut(page);
  expect(await stored(page, "pbs")).toBe(DEVICE_BAD_PBS);
  expect(await activeOf(page)).toBeNull();
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]')).toBeVisible();   // this device's own text, with its recovery message
  expect(await copiesOf(page, uid)).toEqual([["pbs", ACCOUNT_BAD_PBS]]);
});
