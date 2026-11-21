// Signed in (Supabase test mode) with personal bests in the account, while
// the local working copy of the PB list ("pbs") can't be read: malformed
// JSON, or valid JSON in the wrong shape.
//
// Account sync deletes any account PB missing from the local list, and the
// Supabase code syncs after every Save PB / Delete call, whatever the call
// did. So an unreadable local list must never reach a sync: it would be
// read as empty and remove the account's PBs. An unreadable account working
// copy is kept, exactly, for that account before start-up replaces it; and
// this device's own unreadable data is set aside and put back exactly.
// Driven through the real page and supabase-js against the in-memory
// stand-in (support/fake-supabase.js); no real project or credentials.

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
async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#testAccountRow")).not.toContainText("Loading");
  await expect(page.locator("html")).not.toHaveAttribute("data-pbs-loading");
}
async function signUp(page, fake, email) {
  await page.goto("/?supabase");
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
async function addPb(page, event, course, time) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption(event);
  await page.locator("#course").selectOption(course);
  await page.locator("#time").fill(time);
  await page.locator("button[onclick='savePB()']").click();
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your test account.");
}

// A signed-in test account with two PBs in the account.
async function signedInWithRemotePbs(page, context, email) {
  const fake = createFakeSupabase();
  await fake.install(context);
  await signUp(page, fake, email);
  await addPb(page, "Freestyle 50m", "Short Course", "30.00");
  await addPb(page, "Backstroke 50m", "Long Course", "35.00");
  const uid = fake.users.get(email).id;
  const remote = fake.pbsOf(uid);
  expect(remote.map((p) => p.event)).toEqual(["Freestyle 50m", "Backstroke 50m"]);
  return { fake, uid, remote };
}

// Requests (after `from`) that could change PB rows in the account.
const pbWrites = (fake, from) => fake.requests.slice(from)
  .filter((r) => r.method !== "GET" && /personal_bests|pb_entries|add_pb_entries/.test(r.path))
  .map((r) => `${r.method} ${r.path}${r.search}`);

const stored = (page, key = "pbs") => page.evaluate((k) => localStorage.getItem(k), key);

// The per-account copies of unreadable text kept for `uid` (test mode keys).
const accountCopies = (page, uid) => page.evaluate((prefix) => Object.keys(localStorage)
  .filter((k) => k.startsWith(prefix)).sort()
  .map((k) => ({ key: k.slice(prefix.length).split(":")[0], raw: localStorage.getItem(k), storageKey: k })),
`swimtics-test:unreadableCopy:${uid}:`);

async function logOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([page.waitForEvent("load"), page.locator("button[onclick='logoutUser()']").click()]);
  await ready(page);
  await enter(page);
}

// Lets anything a click queued (account sync runs on a promise chain) start.
const settle = (page) => page.evaluate(() => new Promise((r) => setTimeout(r, 750)));

const CASES = [
  ["malformed JSON", '[{"event":"Freestyle 50m","course":"Short Course","time":"30.00"'],
  // read by account sync as two PBs it can't use, so as an empty list
  ["wrong shape: PBs without a course or time", '[{"event":"Freestyle 50m"},{"event":"Backstroke 50m"}]'],
  ["wrong shape: an object, not a list", '{"event":"Freestyle 50m","course":"Short Course","time":"30.00"}'],
];

test.beforeEach(async ({ context }) => {
  await context.route(ANALYTICS, (r) => r.abort());
});

for (const [label, raw] of CASES) {
  test.describe(`signed in, local PBs ${label}`, () => {
    test("Delete and Save PB are held back: no sync runs, the account's PBs and the local value are unchanged, and Start fresh isn't offered", async ({ page, context }) => {
      test.setTimeout(90_000);
      const { fake, uid, remote } = await signedInWithRemotePbs(page, context, "midsession@example.com");

      // the local copy becomes unreadable during the session (e.g. another tab)
      await page.evaluate(() => window.showPage("pb"));
      await expect(page.locator("#pbList .pb-item")).toHaveCount(2);
      await page.evaluate((v) => localStorage.setItem("pbs", v), raw);
      await page.evaluate(() => { document.getElementById("pbSyncStatus").textContent = ""; });
      const from = fake.requests.length;

      // Delete on the list still on screen
      await page.locator("#pbList button[onclick='deletePB(0)']").click();
      await expect(page.locator("#pbBlockedError")).toHaveText(/^Your saved personal bests can't be read/);
      await settle(page);
      // Save PB
      await page.locator("#time").fill("29.00");
      await page.locator("button[onclick='savePB()']").click();
      await expect(page.locator("#pbBlockedError")).toBeVisible();
      await settle(page);

      await expect(page.locator("#pbSyncStatus")).toHaveText("");            // no sync was started
      expect(pbWrites(fake, from)).toEqual([]);
      expect(fake.pbsOf(uid)).toEqual(remote);
      expect(await stored(page)).toBe(raw);

      // the recovery message: backup only, no Start fresh while signed in
      const panel = page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]');
      await expect(panel).toContainText("You're signed in, so this copy belongs to your account.");
      await expect(panel.getByRole("button", { name: "Download a backup" })).toBeVisible();
      await expect(panel.getByRole("button", { name: /Start fresh|Remove and start fresh/ })).toHaveCount(0);
    });

    test("reloading while signed in: the unreadable copy is kept exactly for this account, no PB write is made, and Discard removes only that copy", async ({ page, context }) => {
      test.setTimeout(90_000);
      const email = "reload@example.com";
      const { fake, uid, remote } = await signedInWithRemotePbs(page, context, email);

      await page.evaluate((v) => localStorage.setItem("pbs", v), raw);
      const from = fake.requests.length;
      await page.reload();
      await ready(page);
      await enter(page);
      await signedInAs(page, email);
      await settle(page);

      expect(pbWrites(fake, from)).toEqual([]);
      expect(fake.pbsOf(uid)).toEqual(remote);
      // the account's PBs are what's shown
      await page.evaluate(() => window.showPage("pb"));
      await expect(page.locator("#pbList .pb-title")).toHaveText(["Freestyle 50m (Short Course) - 30.00", "Backstroke 50m (Long Course) - 35.00"]);

      // the unreadable text was kept, exactly, under this account's own key
      const copies = await accountCopies(page, uid);
      expect(copies.map(({ key, raw: r }) => ({ key, raw: r }))).toEqual([{ key: "pbs", raw }]);

      // Profile shows it, with a byte-exact backup and Discard
      await page.evaluate(() => window.showPage("profile"));
      const panel = page.locator("#profileDataRecovery .saved-data-account-copy");
      await expect(panel).toHaveCount(1);
      await expect(panel).toContainText("An unreadable copy of your account's personal bests was kept");
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        panel.getByRole("button", { name: "Download a backup" }).click(),
      ]);
      const fs = await import("node:fs/promises");
      expect(await fs.readFile(await download.path(), "utf8")).toBe(raw);

      const before = fake.requests.length;
      const otherKeys = await page.evaluate(() => Object.keys(localStorage).sort());
      await panel.getByRole("button", { name: "Discard this copy…" }).click();
      await panel.getByRole("button", { name: "Discard", exact: true }).click();
      await expect(page.locator("#profileDataRecovery .saved-data-account-copy")).toHaveCount(0);
      await expect(page.locator("#profileSaveStatus")).toHaveText("The unreadable copy of your account's personal bests was removed from this browser.");
      expect(await accountCopies(page, uid)).toEqual([]);
      expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual(otherKeys.filter((k) => k !== copies[0].storageKey));
      await settle(page);
      expect(fake.requests.slice(before)).toEqual([]);                       // Discard sends nothing
      expect(fake.pbsOf(uid)).toEqual(remote);
    });
  });
}

test.describe("signed in: account sync never sends a PB list that can't be read", () => {
  test("a Save PB or Delete call that doesn't come from a button (so the click guard doesn't apply) still sends nothing", async ({ page, context }) => {
    test.setTimeout(90_000);
    const raw = CASES[0][1];
    const { fake, uid, remote } = await signedInWithRemotePbs(page, context, "direct@example.com");
    await page.evaluate(() => window.showPage("pb"));
    await page.evaluate((v) => localStorage.setItem("pbs", v), raw);
    const from = fake.requests.length;

    await page.evaluate(() => window.deletePB(0));
    await settle(page);
    await page.locator("#time").fill("29.00");
    await page.evaluate(() => window.savePB());
    await settle(page);

    expect(pbWrites(fake, from)).toEqual([]);
    expect(fake.pbsOf(uid)).toEqual(remote);
    expect(await stored(page)).toBe(raw);
    await expect(page.locator("#pbSyncStatus")).toHaveText("Not saved to your test account: the personal bests saved on this device can't be read, so nothing was sent.");
  });

  test("reloading while signed in with an unreadable profile keeps it exactly for this account and changes nothing in the account", async ({ page, context }) => {
    test.setTimeout(90_000);
    const email = "profile-reload@example.com";
    const { fake, uid, remote } = await signedInWithRemotePbs(page, context, email);
    const rawProfile = '{"name":"Sam","club":';
    await page.evaluate((v) => localStorage.setItem("profile", v), rawProfile);
    const from = fake.requests.length;
    await page.reload();
    await ready(page);
    await enter(page);
    await signedInAs(page, email);
    await settle(page);

    // no profile or PB write (loading the photo's signed URL is a read made with POST)
    expect(fake.requests.slice(from)
      .filter((r) => r.method !== "GET" && /profiles|personal_bests|pb_entries|add_pb_entries|device_imports/.test(r.path))
      .map((r) => `${r.method} ${r.path}`)).toEqual([]);
    expect(fake.pbsOf(uid)).toEqual(remote);
    expect((await accountCopies(page, uid)).map(({ key, raw: r }) => ({ key, raw: r }))).toEqual([{ key: "profile", raw: rawProfile }]);
    await expect(page.locator("#profileDataRecovery .saved-data-account-copy")).toContainText("An unreadable copy of your account's profile was kept");
  });
});

test.describe("this device's own data can't be read when someone signs in", () => {
  const DEVICE_PBS = '[{"event":"Freestyle 50m","course":"Short Course","time":"28.00"';
  const DEVICE_PROFILE = '["not", "a", "profile"]';

  test("it is set aside exactly, noted on Profile, never offered for import, and put back exactly on log out", async ({ page, context }) => {
    test.setTimeout(120_000);
    const fake = createFakeSupabase();
    await fake.install(context);
    await page.goto("/?supabase");
    await page.evaluate(([p, b]) => { localStorage.setItem("profile", p); localStorage.setItem("pbs", b); }, [DEVICE_PROFILE, DEVICE_PBS]);
    const email = "device@example.com";
    await signUp(page, fake, email);
    const uid = fake.users.get(email).id;

    // set aside exactly as saved; the account's (empty) data is shown
    expect(await stored(page, "swimtics-test:guestPbs")).toBe(DEVICE_PBS);
    expect(await stored(page, "swimtics-test:guestProfile")).toBe(DEVICE_PROFILE);
    await expect(page.locator("#profileDataRecovery .saved-data-device-note")).toHaveText(
      "This device's own saved personal bests and profile can't be read. They're kept on this device exactly as saved and will come back when you log out, where you can save a backup or start fresh.");
    await expect(page.locator("#testImportOffer")).toHaveCount(0);
    await expect(page.locator("#profileDataRecovery .saved-data-account-copy")).toHaveCount(0);
    expect(fake.pbsOf(uid)).toEqual([]);
    expect(await accountCopies(page, uid)).toEqual([]);

    await logOut(page);
    expect(await stored(page, "pbs")).toBe(DEVICE_PBS);
    expect(await stored(page, "profile")).toBe(DEVICE_PROFILE);
    await page.evaluate(() => window.showPage("pb"));
    await expect(page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]')).toBeVisible();
    await page.evaluate(() => window.showPage("profile"));
    await expect(page.locator('#profileDataRecovery .saved-data-recovery[data-saved-key="profile"]')).toBeVisible();
    await expect(page.locator("#profileDataRecovery .saved-data-device-note")).toHaveCount(0);
  });
});
