// Saved PBs ("pbs") or profile ("profile") that can't be read, with Firebase
// accounts (account.js), in the real page against the Auth + Database
// emulators (demo-swimtics). Run: npm run test:e2e:emulator
//
// - This device's own unreadable data is set aside exactly as saved when an
//   account signs in, noted on Profile, never offered for import, and put
//   back exactly on sign-out.
// - An account's unreadable working copy is kept, exactly, for that account
//   before start-up replaces it, and can be backed up or discarded only
//   while that account is signed in.
// - Nothing unreadable is ever sent to the account, whatever calls the sync.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const PROJECT = "demo-swimtics";
const AUTH = "http://127.0.0.1:9099";
const DB = "http://127.0.0.1:9000";
const NS = `${PROJECT}-default-rtdb`;
const APP = "/index.html?emulator";
const PASSWORD = "swim-fast-123";

async function resetEmulators() {
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  await fetch(`${DB}/.json?ns=${NS}`, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
}

async function readDb(path) {
  const res = await fetch(`${DB}/${path}.json?ns=${NS}`, { headers: { Authorization: "Bearer owner" } });
  return res.json();
}

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

async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#accountDetails")).toContainText("Your profile details and personal bests are saved to your account.");
}

async function signOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([page.waitForEvent("load"), page.locator('button[onclick="logoutUser()"]').click()]);
  await enter(page);
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
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
const uidOf = (page) => page.evaluate(() => window.auth.currentUser.uid);
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 750)));
const accountCopies = (page, uid) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)).sort()
  .map((k) => ({ key: k.slice(prefix.length).split(":")[0], raw: localStorage.getItem(k), storageKey: k })),
`swimtics:unreadableCopy:${uid}:`);
const pbsInAccount = async (uid) => Object.values((await readDb(`users/${uid}/pbs`)) || {})
  .map((p) => `${p.event} (${p.course}) ${p.time}`).sort();

// A signed-in account with two PBs in it.
async function signedInWithPbs(page, email) {
  await page.goto(APP);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await enter(page);
  await signUp(page, email);
  await signedInAs(page, email);
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");
  await addPb(page, "Backstroke 50m", "Long Course", "35.00");
  const uid = await uidOf(page);
  const remote = await pbsInAccount(uid);
  expect(remote).toEqual(["Backstroke 50m (Long Course) 35.00", "Freestyle 50m (Short Course) 30.00"]);
  return { uid, remote };
}

const MALFORMED_PBS = '[{"event":"Freestyle 50m","course":"Short Course","time":"30.00"';
const WRONG_SHAPE_PBS = '{"event":"Freestyle 50m","course":"Short Course","time":"30.00"}';

test.beforeEach(async () => { await resetEmulators(); });

test("this device's unreadable data is set aside exactly on sign-in, noted, never imported, and put back exactly on sign-out", async ({ page }) => {
  const deviceProfile = '{"name":"Device","club":';
  await page.goto(APP);
  await page.evaluate(([p, b]) => { localStorage.clear(); localStorage.setItem("profile", p); localStorage.setItem("pbs", b); }, [deviceProfile, MALFORMED_PBS]);
  await page.reload();
  await enter(page);

  await signUp(page, "device@example.com");
  await signedInAs(page, "device@example.com");
  const uid = await uidOf(page);

  expect(await stored(page, "swimtics:guest:pbs")).toBe(MALFORMED_PBS);
  expect(await stored(page, "swimtics:guest:profile")).toBe(deviceProfile);
  await expect(page.locator("#profileDataRecovery .saved-data-device-note")).toHaveText(
    "This device's own saved personal bests and profile can't be read. They're kept on this device exactly as saved and will come back when you log out, where you can save a backup or start fresh.");
  await expect(page.locator("#importDialog")).toBeHidden();
  await expect(page.locator("#profileDataRecovery .saved-data-account-copy")).toHaveCount(0);
  expect(await accountCopies(page, uid)).toEqual([]);
  expect(await readDb(`users/${uid}/pbs`)).toBeNull();

  await signOut(page);
  expect(await stored(page, "pbs")).toBe(MALFORMED_PBS);
  expect(await stored(page, "profile")).toBe(deviceProfile);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator('#profileDataRecovery .saved-data-recovery[data-saved-key="profile"]')).toBeVisible();
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]')).toBeVisible();
});

for (const [label, raw] of [["malformed JSON", MALFORMED_PBS], ["wrong shape", WRONG_SHAPE_PBS]]) {
  test(`reloading while signed in with ${label} PBs keeps the copy exactly for this account; backup and Discard work and send nothing`, async ({ page }) => {
    const email = `reload-${label.replace(/\W+/g, "-").toLowerCase()}@example.com`;
    const { uid, remote } = await signedInWithPbs(page, email);

    await page.evaluate((v) => localStorage.setItem("pbs", v), raw);
    await page.reload();
    await enter(page);
    await signedInAs(page, email);
    await settle(page);

    expect(await pbsInAccount(uid)).toEqual(remote);
    const copies = await accountCopies(page, uid);
    expect(copies.map(({ key, raw: r }) => ({ key, raw: r }))).toEqual([{ key: "pbs", raw }]);
    await page.evaluate(() => window.showPage("pb"));
    await expect(page.locator("#pbList .pb-item")).toHaveCount(2);      // the account's PBs

    await page.evaluate(() => window.showPage("profile"));
    const panel = page.locator("#profileDataRecovery .saved-data-account-copy");
    await expect(panel).toContainText("An unreadable copy of your account's personal bests was kept");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "Download a backup" }).click(),
    ]);
    expect(await readFile(await download.path(), "utf8")).toBe(raw);

    await panel.getByRole("button", { name: "Discard this copy…" }).click();
    await panel.getByRole("button", { name: "Cancel" }).click();
    expect(await accountCopies(page, uid)).toHaveLength(1);
    await panel.getByRole("button", { name: "Discard this copy…" }).click();
    await panel.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(page.locator("#profileDataRecovery .saved-data-account-copy")).toHaveCount(0);
    expect(await accountCopies(page, uid)).toEqual([]);
    await settle(page);
    expect(await pbsInAccount(uid)).toEqual(remote);

    // the copy is this account's only: after sign-out it isn't shown or offered
    await page.evaluate((v) => localStorage.setItem("pbs", v), raw);
    await page.reload();
    await enter(page);
    await signedInAs(page, email);
    expect(await accountCopies(page, uid)).toHaveLength(1);
    await signOut(page);
    await expect(page.locator("#profileDataRecovery .saved-data-account-copy")).toHaveCount(0);
    expect(await accountCopies(page, uid)).toHaveLength(1);              // kept on the device, hidden
  });
}

test("signed in with an unreadable PB list or profile, no sync or profile save reaches the account, whatever calls it", async ({ page }) => {
  const { uid, remote } = await signedInWithPbs(page, "direct@example.com");
  const profileBefore = await readDb(`users/${uid}/profile`);

  await page.evaluate(() => window.showPage("pb"));
  await page.evaluate((v) => localStorage.setItem("pbs", v), MALFORMED_PBS);
  await page.evaluate(() => window.deletePB(0));
  await page.evaluate((uid) => window.saveUserData(uid), uid);         // the sync pb.js calls after a save
  await settle(page);
  expect(await pbsInAccount(uid)).toEqual(remote);
  expect(await stored(page, "pbs")).toBe(MALFORMED_PBS);
  await expect(page.locator("#pbSyncStatus")).toHaveText("Not saved to your account: the personal bests saved on this device can't be read, so nothing was sent.");

  const rawProfile = '{"name":"Changed","club":';
  await page.evaluate((v) => localStorage.setItem("profile", v), rawProfile);
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Someone Else");
  await page.evaluate(() => window.saveProfile());
  await settle(page);
  expect(await readDb(`users/${uid}/profile`)).toEqual(profileBefore);
  expect(await stored(page, "profile")).toBe(rawProfile);
  await expect(page.locator("#profileSaveStatus")).toHaveText("Your profile wasn't saved, because the profile saved on this device can't be read. Nothing was sent to your account.");
});
