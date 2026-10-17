// Accounts + Profile/PB sync in the real page, against the Auth + Database
// emulators (demo-swimtics). Run: npm run test:e2e:emulator
import { test, expect } from "@playwright/test";

const PROJECT = "demo-swimtics";
const AUTH = "http://127.0.0.1:9099";
const DB = "http://127.0.0.1:9000";
const NS = `${PROJECT}-default-rtdb`;
const APP = "/index.html?emulator";

async function resetEmulators() {
  await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
  await fetch(`${DB}/.json?ns=${NS}`, { method: "DELETE", headers: { Authorization: "Bearer owner" } });
}

async function oobCodes(email, type) {
  const res = await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`);
  const { oobCodes: codes = [] } = await res.json();
  return codes.filter((c) => c.email === email && c.requestType === type);
}

async function readDb(path) {
  const res = await fetch(`${DB}/${path}.json?ns=${NS}`, { headers: { Authorization: "Bearer owner" } });
  return res.json();
}

async function enter(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

/* open the app with this device's own (signed-out) data already saved */
async function openWithLocalData(page, { profile, pbs }) {
  await page.goto(APP);
  await page.evaluate(([p, b]) => {
    localStorage.clear();
    if (p) localStorage.setItem("profile", JSON.stringify(p));
    if (b) localStorage.setItem("pbs", JSON.stringify(b));
  }, [profile, pbs]);
  await page.reload();
  await enter(page);
}

async function signUp(page, email, password, extras = {}) {
  await page.locator(".site-nav-signin").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator(".auth-switch .auth-link", { hasText: "Sign Up" }).click();
  if (extras.name) await page.locator("#signupFullName").fill(extras.name);
  await page.locator("#signupEmail").fill(email);
  await page.locator("#signupPassword").fill(password);
  await page.locator("#signupView button", { hasText: "Create Account" }).click();
}

async function signIn(page, email, password) {
  await page.locator(".site-nav-signin").click();
  await expect(page.locator("#authModal")).toBeVisible();
  await page.locator("#authEmail").fill(email);
  await page.locator("#authPassword").fill(password);
  await page.locator("#loginView button", { hasText: "Login" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
}

/* signing out reloads the page (clears in-memory session data); pass the gate again */
async function signOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([
    page.waitForEvent("load"),
    page.locator('button[onclick="logoutUser()"]').click(),
  ]);
  await enter(page);
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
}

async function signedInAs(page, email) {
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  // and the account data has finished loading into the page
  await expect(page.locator("#accountDetails")).toContainText("Your profile details and personal bests are saved to your account.");
}

async function addPb(page, event, course, time) {
  await page.evaluate(() => window.showPage("pb"));
  await page.locator("#event").selectOption(event);
  await page.locator("#course").selectOption(course);
  await page.locator("#time").fill(time);
  await page.locator('button[onclick="savePB()"]').click();
}

test.beforeEach(async () => { await resetEmulators(); });

test("sign up sends a verification email; verifying updates the account status", async ({ page }) => {
  await openWithLocalData(page, {});
  await signUp(page, "new@example.com", "swim-fast-123");
  await expect(page.locator("#authModal")).toBeHidden();
  await signedInAs(page, "new@example.com");
  await expect(page.locator("#accountDetails")).toContainText("Email not verified yet");
  await expect(page.locator(".site-nav-signin")).toHaveText("Account");

  const [code] = await oobCodes("new@example.com", "VERIFY_EMAIL");
  expect(code, "verification email requested").toBeTruthy();
  await fetch(code.oobLink);                                   // the user clicks the link
  await page.locator("#accountDetails .auth-link", { hasText: "I've verified" }).click();
  await expect(page.locator("#accountDetails")).toContainText("Email verified.");

  // the password is never stored by the app
  const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
  expect(stored).not.toContain("swim-fast-123");
  const dump = JSON.stringify(await readDb(""));
  expect(dump).not.toContain("swim-fast-123");
});

test("first sign-in offers to import this device's data, previews it, merges it, and doesn't offer twice", async ({ page }) => {
  await openWithLocalData(page, {
    profile: { name: "Device Swimmer", club: "Device Club", level: "Competitive", photo: "data:image/png;base64,AAAA" },
    pbs: [
      { event: "Freestyle 50m", course: "Short Course", time: "28.50", history: [29.4, 28.5] },
      { event: "Backstroke 100m", course: "Long Course", time: "1:05.20", history: [65.2] },
    ],
  });

  await signUp(page, "import@example.com", "swim-fast-123");
  const dlg = page.locator("#importDialog");
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText("name, club, level");
  await expect(dlg).toContainText("Freestyle 50m (Short Course): 2 times");
  await expect(dlg).toContainText("Backstroke 100m (Long Course): 1 time");
  await expect(dlg).toContainText("Photos stay on this device");

  await dlg.locator("#importConfirm").click();
  await expect(dlg).toBeHidden();
  await expect(page.locator("#profileSaveStatus")).toContainText("Imported 3 PB times and 3 profile fields");

  // in the account now
  const uid = await page.evaluate(() => window.auth.currentUser.uid);
  const account = await readDb(`users/${uid}`);
  expect(account.profile.name).toBe("Device Swimmer");
  expect(account.profile.photo).toBeUndefined();
  const free = Object.values(account.pbs).find((p) => p.event === "Freestyle 50m");
  expect(Object.keys(free.history)).toHaveLength(2);
  expect(free.time).toBe("28.50");

  // this device's own copy is kept
  const guest = await page.evaluate(() => JSON.parse(localStorage.getItem("swimtics:guest:pbs")));
  expect(guest).toHaveLength(2);

  // sign out and back in: no second offer, and nothing duplicated
  await page.evaluate(() => window.showPage("profile"));
  await signOut(page);
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
  await signIn(page, "import@example.com", "swim-fast-123");
  await signedInAs(page, "import@example.com");
  await expect(page.locator("#importDialog")).toBeHidden();
  const again = await readDb(`users/${uid}/pbs`);
  expect(Object.keys(Object.values(again).find((p) => p.event === "Freestyle 50m").history)).toHaveLength(2);
});

test("import merges with times already in the account without losing any", async ({ page, browser }) => {
  // the account already has a Freestyle 50m time from another device
  const other = await browser.newPage();
  await openWithLocalData(other, {});
  await signUp(other, "merge@example.com", "swim-fast-123");
  await signedInAs(other, "merge@example.com");
  await addPb(other, "Freestyle 50m", "Short Course", "27.90");
  await expect(other.locator("#pbSyncStatus")).toHaveText("Saved to your account.");
  await other.close();

  await openWithLocalData(page, {
    pbs: [{ event: "Freestyle 50m", course: "Short Course", time: "28.50", history: [28.5] }],
  });
  await signIn(page, "merge@example.com", "swim-fast-123");
  const dlg = page.locator("#importDialog");
  await expect(dlg).toContainText("merged with your account's times");
  await dlg.locator("#importConfirm").click();
  await expect(dlg).toBeHidden();

  const uid = await page.evaluate(() => window.auth.currentUser.uid);
  const free = Object.values(await readDb(`users/${uid}/pbs`))[0];
  expect(Object.values(free.history).map((e) => e.s).sort()).toEqual([27.9, 28.5]);
  expect(free.time).toBe("27.90");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("27.90");
});

test("\"Not now\" keeps data local, isn't asked again, and can still be imported later", async ({ page }) => {
  await openWithLocalData(page, { pbs: [{ event: "Freestyle 50m", course: "Short Course", time: "30.00", history: [30] }] });
  await signUp(page, "later@example.com", "swim-fast-123");
  await page.locator("#importLater").click();
  await expect(page.locator("#importDialog")).toBeHidden();
  const uid = await page.evaluate(() => window.auth.currentUser.uid);
  expect(await readDb(`users/${uid}/pbs`)).toBeNull();

  await page.reload();
  await enter(page);
  await signedInAs(page, "later@example.com");
  await expect(page.locator("#importDialog")).toBeHidden();

  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#accountDetails .auth-link", { hasText: "Import this device" }).click();
  await page.locator("#importConfirm").click();
  await expect(page.locator("#importDialog")).toBeHidden();
  expect(Object.keys(await readDb(`users/${uid}/pbs`))).toHaveLength(1);
});

test("profile and PB changes persist after reload and follow the account to another device", async ({ page, browser }) => {
  await openWithLocalData(page, {});
  await signUp(page, "sync@example.com", "swim-fast-123");
  await signedInAs(page, "sync@example.com");

  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Synced Swimmer");
  await page.locator("#club").fill("Cloud Club");
  await page.locator('button[onclick="saveProfile()"]').click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Saved to your account.");

  await addPb(page, "Butterfly 100m", "Short Course", "1:02.10");
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your account.");
  await addPb(page, "Butterfly 100m", "Short Course", "1:01.40");
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your account.");

  // reload: still signed in, same data
  await page.reload();
  await enter(page);
  await signedInAs(page, "sync@example.com");
  await expect(page.locator("#name")).toHaveValue("Synced Swimmer");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).toContainText("1:01.40");

  // a different device with nothing saved
  const ctx = await browser.newContext();
  const device2 = await ctx.newPage();
  await openWithLocalData(device2, {});
  await signIn(device2, "sync@example.com", "swim-fast-123");
  await signedInAs(device2, "sync@example.com");
  await expect(device2.locator("#name")).toHaveValue("Synced Swimmer");
  await expect(device2.locator("#club")).toHaveValue("Cloud Club");
  await device2.evaluate(() => window.showPage("pb"));
  await expect(device2.locator("#pbList")).toContainText("1:01.40");
  const hist = await device2.evaluate(() => JSON.parse(localStorage.getItem("pbs"))[0].history);
  expect(hist).toEqual([62.1, 61.4]);

  // deleting a PB on device 2 removes it from the account
  await device2.locator("#pbList button", { hasText: /delete/i }).first().click();
  await expect(device2.locator("#pbSyncStatus")).toHaveText("Saved to your account.");
  const uid = await device2.evaluate(() => window.auth.currentUser.uid);
  expect(await readDb(`users/${uid}/pbs`)).toBeNull();
  await ctx.close();
});

test("signing out restores this device's own data and hides the account's", async ({ page }) => {
  await openWithLocalData(page, {
    profile: { name: "Guest On This Device" },
    pbs: [{ event: "Freestyle 50m", course: "Short Course", time: "31.00", history: [31] }],
  });
  await signUp(page, "switch@example.com", "swim-fast-123", { name: "Account Owner" });
  await page.locator("#importLater").click();
  await signedInAs(page, "switch@example.com");
  await expect(page.locator("#name")).toHaveValue("Account Owner");
  await expect(page.locator("#accountDetails .account-line.notice")).toHaveText(
    "You stay signed in on this browser until you log out. On a shared device, use Log Out below when you're done.");
  await expect(page.locator('button[onclick="logoutUser()"]')).toBeVisible();

  await signOut(page);
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
  await expect(page.locator("#name")).toHaveValue("Guest On This Device");
  await expect(page.locator(".site-nav-signin")).toHaveText("Sign In");
  const working = await page.evaluate(() => JSON.parse(localStorage.getItem("pbs")));
  expect(working).toEqual([{ event: "Freestyle 50m", course: "Short Course", time: "31.00", history: [31] }]);
});

test("password reset: neutral message, and the emailed link sets a new password", async ({ page }) => {
  await openWithLocalData(page, {});
  await signUp(page, "reset@example.com", "old-password-1");
  await signedInAs(page, "reset@example.com");
  await signOut(page);

  await page.locator(".site-nav-signin").click();
  await page.locator("#authEmail").fill("reset@example.com");
  await page.locator(".auth-link", { hasText: "Forgot password?" }).click();
  await expect(page.locator("#authMessage")).toContainText("If an account exists for that email");

  // an unknown email gets the same message (no account enumeration)
  await page.locator("#authEmail").fill("nobody@example.com");
  await page.locator(".auth-link", { hasText: "Forgot password?" }).click();
  await expect(page.locator("#authMessage")).toContainText("If an account exists for that email");

  const [code] = await oobCodes("reset@example.com", "PASSWORD_RESET");
  expect(code).toBeTruthy();
  await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=demo-api-key`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oobCode: code.oobCode, newPassword: "new-password-2" }),
  });

  await page.locator("#authPassword").fill("old-password-1");
  await page.locator("#authEmail").fill("reset@example.com");
  await page.locator("#loginView button", { hasText: "Login" }).click();
  await expect(page.locator("#authMessage")).toContainText("Email or password is incorrect.");
  await expect(page.locator("#authPassword")).toHaveValue("");
  await page.locator("#authPassword").fill("new-password-2");
  await page.locator("#loginView button", { hasText: "Login" }).click();
  await expect(page.locator("#authModal")).toBeHidden();
  await signedInAs(page, "reset@example.com");
});

test("in the browser, a signed-in user cannot read another user's data", async ({ page, browser }) => {
  const ctxA = await browser.newContext();
  const a = await ctxA.newPage();
  await openWithLocalData(a, {});
  await signUp(a, "owner@example.com", "swim-fast-123", { name: "Private Name" });
  await signedInAs(a, "owner@example.com");
  const uidA = await a.evaluate(() => window.auth.currentUser.uid);
  await ctxA.close();

  await openWithLocalData(page, {});
  await signUp(page, "intruder@example.com", "swim-fast-123");
  await signedInAs(page, "intruder@example.com");
  const result = await page.evaluate(async (uid) => {
    const { db, dbFns } = window.swimticsFirebase;
    try { await dbFns.get(dbFns.ref(db, `users/${uid}`)); return "read allowed"; }
    catch (e) { return String(e.message || e); }
  }, uidA);
  expect(result).toMatch(/permission/i);
  await expect(page.locator("body")).not.toContainText("Private Name");
});

test("signed out, Save Profile saves on this device and says so", async ({ page }) => {
  await openWithLocalData(page, {});
  await page.evaluate(() => window.showPage("profile"));
  await page.locator("#name").fill("Local Only");
  await page.locator('button[onclick="saveProfile()"]').click();
  await expect(page.locator("#profileSaveStatus")).toContainText("Saved on this device. Sign in to keep it in your account.");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).name)).toBe("Local Only");
});

/* ---------------- shared browser / account switching ---------------- */

/* Hold every client->server message on the Realtime Database socket while
   `state.blocked` is true, so a write stays in flight (as on a bad network). */
async function controllableDb(page) {
  const state = { blocked: false, held: 0 };
  await page.routeWebSocket(/127\.0\.0\.1:9000/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => { if (state.blocked) state.held += 1; else server.send(m); });
  });
  return state;
}

test("shared browser: after sign-out the next person sees none of the previous account's data or photos", async ({ page }) => {
  await openWithLocalData(page, {
    profile: { name: "Device Owner", photo: "data:image/png;base64,REVWSUNF" },
  });
  await page.evaluate(() => localStorage.setItem("strokeData", JSON.stringify({ freestyle: { photo: "data:image/png;base64,REVWU1RST0tF" } })));
  await page.reload(); await enter(page);

  await signUp(page, "first@example.com", "swim-fast-123", { name: "First User" });
  await page.locator("#importLater").click();
  await signedInAs(page, "first@example.com");
  // the device's photos are not shown in someone's account
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).photo)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem("strokeData"))).toBe("{}");
  await addPb(page, "Freestyle 50m", "Short Course", "27.00");
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saved to your account.");

  await signOut(page);
  const after = await page.evaluate(() => ({
    profile: JSON.parse(localStorage.getItem("profile")),
    pbs: JSON.parse(localStorage.getItem("pbs")),
    active: localStorage.getItem("swimtics:activeUid"),
    pending: Object.keys(localStorage).filter((k) => k.startsWith("swimtics:pendingData:")),
    loginEmail: document.getElementById("authEmail").value,
  }));
  expect(after.profile.name).toBe("Device Owner");
  expect(after.pbs).toEqual([]);
  expect(after.active).toBeNull();
  expect(after.pending).toEqual([]);
  expect(after.loginEmail).toBe("");
  await expect(page.locator("body")).not.toContainText("First User");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).not.toContainText("27.00");

  // a second person signs in on the same browser
  await signUp(page, "second@example.com", "swim-fast-123");
  await page.locator("#importLater").click();
  await signedInAs(page, "second@example.com");
  await expect(page.locator("#name")).toHaveValue("");
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).not.toContainText("27.00");
  await expect(page.locator("body")).not.toContainText("First User");
});

test("an account's local-only photo stays on this device after sign-out, hidden, and returns only for that account", async ({ page }) => {
  await openWithLocalData(page, { profile: { name: "Device Owner" } });
  await signUp(page, "photo@example.com", "swim-fast-123", { name: "Photo Owner" });
  await page.locator("#importLater").click();
  await signedInAs(page, "photo@example.com");
  const uid = await page.evaluate(() => window.auth.currentUser.uid);
  // the same write the profile photo picker makes
  await page.evaluate(() => {
    const profile = JSON.parse(localStorage.getItem("profile")) || {};
    profile.photo = "data:image/png;base64,T1dORVI=";
    localStorage.setItem("profile", JSON.stringify(profile));
    window.loadProfile();
  });

  await signOut(page);
  const after = await page.evaluate((u) => ({
    workingPhoto: JSON.parse(localStorage.getItem("profile")).photo,
    kept: JSON.parse(localStorage.getItem(`swimtics:localPhotos:${u}`)),
  }), uid);
  expect(after.workingPhoto).toBeUndefined();                 // not shown to the device owner
  expect(after.kept.photo).toBe("data:image/png;base64,T1dORVI="); // but not deleted
  expect(await readDb(`users/${uid}/profile/photo`)).toBeNull();   // and never sent to the database

  await signUp(page, "other@example.com", "swim-fast-123");
  await page.locator("#importLater").click();
  await signedInAs(page, "other@example.com");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).photo)).toBeUndefined();

  await signOut(page);
  await signIn(page, "photo@example.com", "swim-fast-123");
  await signedInAs(page, "photo@example.com");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).photo)).toBe("data:image/png;base64,T1dORVI=");
});

test("shared browser: a save still in flight at sign-out is never shown to, or written for, the next user", async ({ page }) => {
  const net = await controllableDb(page);
  await openWithLocalData(page, {});
  await signUp(page, "alpha@example.com", "swim-fast-123");
  await signedInAs(page, "alpha@example.com");
  const alphaUid = await page.evaluate(() => window.auth.currentUser.uid);

  net.blocked = true;                                          // the network stalls
  await addPb(page, "Butterfly 50m", "Short Course", "30.10");
  await expect(page.locator("#pbSyncStatus")).toHaveText("Saving to your account…");
  const pending = await page.evaluate((uid) => JSON.parse(localStorage.getItem(`swimtics:pendingData:${uid}`)), alphaUid);
  expect(pending.pbs.data.pbs[0].event).toBe("Butterfly 50m");  // backed up for alpha, before the write
  await expect(page.locator("#pbSyncStatus")).toContainText("Still saving", { timeout: 15_000 });

  await signOut(page);                                         // takes effect even with the save stuck
  net.blocked = false;
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).not.toContainText("30.10");

  await signUp(page, "beta@example.com", "swim-fast-123");
  await signedInAs(page, "beta@example.com");
  const betaUid = await page.evaluate(() => window.auth.currentUser.uid);
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pbList")).not.toContainText("30.10");
  expect(await readDb(`users/${betaUid}/pbs`)).toBeNull();      // nothing of alpha's in beta's account
  const kept = await page.evaluate((uid) => !!localStorage.getItem(`swimtics:pendingData:${uid}`), alphaUid);
  expect(kept, "alpha's unsynced change is still waiting for alpha").toBe(true);

  // alpha comes back on this browser: the change is delivered to alpha only
  await signOut(page);
  await signIn(page, "alpha@example.com", "swim-fast-123");
  await signedInAs(page, "alpha@example.com");
  await expect(page.locator("#profileSaveStatus")).toContainText("Earlier changes from this device have now been saved");
  const alphaPbs = Object.values(await readDb(`users/${alphaUid}/pbs`));
  expect(alphaPbs.map((p) => p.event)).toEqual(["Butterfly 50m"]);
  expect(Object.keys(alphaPbs[0].history)).toHaveLength(1);
  expect(await readDb(`users/${betaUid}/pbs`)).toBeNull();
});

test("signing out in another tab immediately clears this tab too", async ({ context }) => {
  const tab1 = await context.newPage();
  await openWithLocalData(tab1, { profile: { name: "Device Owner" } });
  await signUp(tab1, "tabs@example.com", "swim-fast-123", { name: "Tab User" });
  await tab1.locator("#importLater").click();
  await signedInAs(tab1, "tabs@example.com");

  const tab2 = await context.newPage();
  await tab2.goto(APP);
  await enter(tab2);
  await signedInAs(tab2, "tabs@example.com");
  await expect(tab2.locator("#name")).toHaveValue("Tab User");

  const reloaded = tab1.waitForEvent("load");
  await signOut(tab2);
  await reloaded;                                              // the other tab cleaned itself up
  await enter(tab1);
  await expect(tab1.locator("#accountDetails")).toContainText("not signed in");
  await expect(tab1.locator("#name")).toHaveValue("Device Owner");
  await expect(tab1.locator("body")).not.toContainText("Tab User");
});

test("if the session ended while the page was closed, the account's data isn't shown on next open", async ({ page }) => {
  await openWithLocalData(page, { profile: { name: "Device Owner" } });
  await signUp(page, "expired@example.com", "swim-fast-123", { name: "Expired User" });
  await page.locator("#importLater").click();
  await signedInAs(page, "expired@example.com");

  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).name)).toBe("Expired User");

  // Close the app, then the stored Firebase session disappears (expired or
  // cleared) while the working copy on the device still holds the account.
  // The session is kept in localStorage (browserLocalPersistence).
  await page.goto("/favicon.png");                              // same origin, app not running
  const removed = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("firebase:authUser:"));
    keys.forEach((k) => localStorage.removeItem(k));
    return keys.length;
  });
  expect(removed).toBe(1);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      window.__profileAtDomReady = localStorage.getItem("profile");
    });
  });
  await page.goto(APP);
  const atDomReady = await page.evaluate(() => window.__profileAtDomReady);
  expect(JSON.parse(atDomReady).name).toBe("Device Owner");     // never the account's data
  await enter(page);
  await expect(page.locator("#accountDetails")).toContainText("not signed in");
  await expect(page.locator("body")).not.toContainText("Expired User");
});
