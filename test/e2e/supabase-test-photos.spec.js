// Profile photos in Supabase test mode (src/app/data/supabase-test-photos.js,
// used by supabase-accounts-core.js), driven through the real page with the
// real supabase-js client against the in-memory stand-in
// (support/fake-supabase.js), which mirrors the private bucket and owner-only
// policies of supabase/sql/003_profile_photos.sql. No real project,
// credentials or email are involved. Analytics hosts are blocked.

import { test, expect } from "@playwright/test";
import { createFakeSupabase } from "./support/fake-supabase.js";
import { jpegInfo } from "../../src/app/data/supabase-test-photos.js";

const ANALYTICS = /googletagmanager\.com|google-analytics\.com|clarity\.ms/;
const PASSWORD = "swim-fast-123";
const SECRET = "SWIMTICS-GPS-12.9716N-77.5946E";       // stands in for location data in the original file
/* a 1x1 PNG: this device's own (signed-out) photo */
const DEVICE_PHOTO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
async function signedInAs(page, email) {
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#accountDetails")).toContainText(`Signed in as ${email}`);
  await expect(page.locator("#testAccountRow")).not.toContainText("Loading");
  await expect(page.locator("#testAccountPhoto")).not.toContainText("Loading");
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
  return fake.users.get(email).id;
}
async function logOut(page) {
  await page.evaluate(() => window.showPage("profile"));
  await Promise.all([page.waitForEvent("load"), page.locator("button[onclick='logoutUser()']").click()]);
  await ready(page);
  await enter(page);
}

/* A real JPEG (drawn in this browser) with an EXIF block added: orientation 6
   (rotate 90°) and a stand-in for GPS data. */
async function exifPhoto(page, width = 800, height = 400) {
  const base = Buffer.from(await page.evaluate(async ([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#d33"; g.fillRect(0, 0, w / 2, h);
    g.fillStyle = "#33d"; g.fillRect(w / 2, 0, w / 2, h);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
    return [...new Uint8Array(await blob.arrayBuffer())];
  }, [width, height]));
  const tiff = Buffer.concat([
    Buffer.from("MM\0*", "latin1"), Buffer.from([0, 0, 0, 8]),            // big-endian, IFD at 8
    Buffer.from([0, 1]),                                                  // one entry
    Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0]),              // Orientation = 6
    Buffer.from([0, 0, 0, 0]),                                            // no next IFD
    Buffer.from(SECRET, "latin1"),
  ]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
  const file = Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
  expect(jpegInfo(file).hasExif, "the fixture really carries EXIF").toBe(true);
  return { name: "holiday.jpg", mimeType: "image/jpeg", buffer: file };
}

async function choosePhoto(page, file) {
  await page.evaluate(() => window.showPage("profile"));
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.locator("#profileImageBox").click()]);
  await chooser.setFiles(file);
}

/* Everything this page keeps in browser storage, as one string. */
async function deviceStorage(page) {
  return page.evaluate(async () => JSON.stringify({
    local: Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])),
    session: Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)])),
    caches: typeof caches === "undefined" ? [] : await caches.keys(),
  }));
}

const storageRequests = (fake) => fake.requests.filter((r) => r.path.startsWith("/storage/"));

test.beforeEach(async ({ context }) => {
  await context.route(ANALYTICS, (r) => r.abort());
});

test("a photo chosen while signed in is resized, stripped of EXIF and stored only at the user's own private path", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  const uid = await signUp(page, fake, "photo-a@example.com");
  await expect(page.locator("#testAccountPhoto")).toContainText("No photo in your test account");

  await choosePhoto(page, await exifPhoto(page));
  await expect(page.locator("#profileSaveStatus")).toHaveText("Photo saved to your test account. It isn't kept on this device after you log out.");

  const uploads = storageRequests(fake).filter((r) => r.method === "POST" && !r.path.includes("/sign/"));
  expect(uploads.map((r) => r.path)).toEqual([`/storage/v1/object/profile-photos/${uid}/profile.jpg`]);
  expect(uploads[0].contentType).toBe("image/jpeg");
  expect(uploads[0].upsert).toBe("true");
  expect(fake.tokenOwner(uploads[0].authorization)).toBe(uid);

  const stored = fake.photoOf(uid);
  const info = jpegInfo(stored);
  expect(info.isJpeg).toBe(true);
  expect(info.hasExif).toBe(false);
  expect(info.hasMetadata).toBe(false);
  expect(stored.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
  expect([info.width, info.height], "rotated per EXIF, then fitted within 512 px").toEqual([256, 512]);
  expect(stored.length).toBeLessThanOrEqual(1048576);

  await expect(page.locator("#profileImageBox img")).toHaveAttribute("src", /^blob:/);
  await expect(page.locator("#testAccountPhoto")).toContainText("saved privately");
  const kept = await deviceStorage(page);
  expect(kept).not.toContain(SECRET);
  expect(kept).not.toContain("data:image");
  expect(kept).not.toContain("blob:");
  expect(kept).not.toContain("token=");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")).photo)).toBeUndefined();
});

test("the account photo comes back from a short-lived signed URL after reload, and is gone from the device after logout", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await page.goto("/?supabase");
  await page.evaluate((photo) => localStorage.setItem("profile", JSON.stringify({ name: "Device Owner", photo })), DEVICE_PHOTO);
  await page.reload();
  await ready(page);
  await enter(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#profileImageBox img")).toHaveAttribute("src", DEVICE_PHOTO);

  const uid = await signUp(page, fake, "photo-b@example.com");
  await expect(page.locator("#profileImageBox"), "the device's photo isn't shown for the account").toHaveText("Upload Image");
  expect(storageRequests(fake).filter((r) => r.method === "POST" && !r.path.includes("/sign/")), "the device photo is not uploaded").toEqual([]);

  await choosePhoto(page, await exifPhoto(page, 300, 300));
  await expect(page.locator("#profileSaveStatus")).toContainText("Photo saved");

  await page.reload();
  await ready(page);
  await enter(page);
  await signedInAs(page, "photo-b@example.com");
  await expect(page.locator("#profileImageBox img")).toHaveAttribute("src", /^blob:/);
  const signs = storageRequests(fake).filter((r) => r.method === "POST" && r.path.includes("/sign/"));
  expect(signs.at(-1).path).toBe(`/storage/v1/object/sign/profile-photos/${uid}/profile.jpg`);
  expect(JSON.parse(signs.at(-1).body).expiresIn).toBe(60);
  const downloads = storageRequests(fake).filter((r) => r.method === "GET");
  expect(downloads.length).toBeGreaterThanOrEqual(1);
  expect(downloads.at(-1).apikey, "the signed URL is fetched on its own (no key, no session)").toBeUndefined();

  const before = fake.requests.length;
  await logOut(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#profileImageBox img")).toHaveAttribute("src", DEVICE_PHOTO);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("profile")))).toEqual({ name: "Device Owner", photo: DEVICE_PHOTO });
  const kept = await deviceStorage(page);
  expect(kept).not.toContain("blob:");
  expect(kept).not.toContain("token=");
  expect(kept).not.toContain(uid + "/profile.jpg");
  expect(fake.requests.slice(before).filter((r) => r.path.startsWith("/storage/")), "nothing about photos is requested after logout").toEqual([]);
});

test("one account never sees another account's photo", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  const a = await signUp(page, fake, "photo-owner@example.com");
  await choosePhoto(page, await exifPhoto(page));
  await expect(page.locator("#profileSaveStatus")).toContainText("Photo saved");
  await logOut(page);

  const b = await signUp(page, fake, "photo-other@example.com");
  await expect(page.locator("#profileImageBox")).toHaveText("Upload Image");
  await expect(page.locator("#testAccountPhoto")).toContainText("No photo in your test account");
  for (const r of storageRequests(fake).filter((x) => fake.tokenOwner(x.authorization) === b)) {
    expect(r.path, "B only ever asks for B's own photo").not.toContain(a);
  }
  // asking the stand-in directly with B's session for A's photo is refused, as the policies do
  const bToken = fake.requests.filter((r) => fake.tokenOwner(r.authorization) === b).at(-1).authorization;
  const answer = await page.evaluate(async ([url, key, token, path]) => {
    const res = await fetch(`${url}/storage/v1/object/sign/profile-photos/${path}`, {
      method: "POST", headers: { apikey: key, authorization: token, "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 60 }),
    });
    return { status: res.status, body: await res.json() };
  }, ["https://fake-swimtics-test.supabase.co", "sb_publishable_fakeTestKey123", bToken, `${a}/profile.jpg`]);
  expect(answer.body.statusCode).toBe("404");
  expect(fake.photoOf(a)).not.toBeNull();
});

test("signed out, a chosen photo stays on this device only, as before; nothing is uploaded", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await choosePhoto(page, { name: "me.png", mimeType: "image/png", buffer: Buffer.from(DEVICE_PHOTO.split(",")[1], "base64") });
  await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem("profile") || "{}").photo || "").slice(0, 22))).toBe("data:image/png;base64,");
  await expect(page.locator("#profileImageBox img")).toHaveAttribute("src", /^data:image\/png/);
  expect(storageRequests(fake)).toEqual([]);
});

test("unsupported files are refused before anything is uploaded", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await signUp(page, fake, "photo-c@example.com");
  for (const file of [
    { name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") },
    { name: "x.heic", mimeType: "image/heic", buffer: Buffer.from("not really heic") },
    { name: "x.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not a jpeg at all") },
  ]) {
    await choosePhoto(page, file);
    await expect(page.locator("#profileSaveStatus")).toHaveAttribute("data-kind", "error");
    await expect(page.locator("#profileSaveStatus")).toContainText(file.mimeType === "image/jpeg" ? "couldn't be read" : "JPEG, PNG or WebP");
  }
  expect(storageRequests(fake).filter((r) => r.method === "POST" && !r.path.includes("/sign/"))).toEqual([]);
  await expect(page.locator("#profileImageBox")).toHaveText("Upload Image");
});

test("removing the photo deletes it from the account", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  const uid = await signUp(page, fake, "photo-d@example.com");
  await choosePhoto(page, await exifPhoto(page));
  await expect(page.locator("#profileSaveStatus")).toContainText("Photo saved");
  await page.locator("#testAccountPhoto").getByRole("button", { name: "Remove photo" }).click();
  await expect(page.locator("#profileSaveStatus")).toHaveText("Photo removed from your test account.");
  expect(fake.photoOf(uid)).toBeNull();
  const del = storageRequests(fake).find((r) => r.method === "DELETE");
  expect(JSON.parse(del.body)).toEqual({ prefixes: [`${uid}/profile.jpg`] });
  await expect(page.locator("#profileImageBox")).toHaveText("Upload Image");
  await page.reload();
  await ready(page);
  await enter(page);
  await signedInAs(page, "photo-d@example.com");
  await expect(page.locator("#profileImageBox")).toHaveText("Upload Image");
});

test("a photo that can't be loaded says so instead of loading forever", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await context.route("https://fake-swimtics-test.supabase.co/storage/v1/object/sign/**", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: 500, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ statusCode: "500", error: "internal", message: "boom" }) })
      : route.fallback());
  await openTestMode(page);
  await page.locator(".site-nav-signin").click();
  await page.locator("#loginView").getByRole("button", { name: "Sign Up" }).click();
  await page.locator("#signupEmail").fill("photo-e@example.com");
  await page.locator("#signupPassword").fill(PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page.locator("#authMessage")).toContainText("Check your email for a confirmation link");
  await page.goto(fake.lastMail("photo-e@example.com", "confirm").link);
  await ready(page);
  await enter(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#testAccountPhoto")).toContainText("couldn't be loaded");
  await expect(page.locator("#profileSaveStatus")).toHaveText("Couldn't load your test account's photo.");
  await expect(page.locator("#profileImageBox")).toHaveText("Upload Image");
});

test("a new photo chosen while the old one is still loading is the one that stays", async ({ page, context }) => {
  const fake = createFakeSupabase();
  await fake.install(context);
  await openTestMode(page);
  await signUp(page, fake, "photo-f@example.com");
  await choosePhoto(page, await exifPhoto(page));                        // shown 256 x 512
  await expect(page.locator("#profileSaveStatus")).toContainText("Photo saved");

  let release;
  const held = new Promise((r) => { release = r; });
  const uid = fake.users.get("photo-f@example.com").id;
  await context.route("https://fake-swimtics-test.supabase.co/storage/v1/object/sign/**", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const oldBytes = fake.photoOf(uid);                                  // the reload's download: the OLD photo,
    await held;                                                          // delivered only after a new one is saved
    await route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "image/jpeg" }, body: oldBytes });
  });
  await page.reload();
  await ready(page);
  await enter(page);
  await page.evaluate(() => window.showPage("profile"));
  await expect(page.locator("#testAccountPhoto")).toContainText("Loading");
  await choosePhoto(page, await exifPhoto(page, 300, 300));              // shown 300 x 300 (orientation 6 on a square)
  await expect(page.locator("#profileSaveStatus")).toContainText("Photo saved");
  release();
  await page.waitForTimeout(1000);
  const shown = await page.locator("#profileImageBox img").evaluate((img) => img.decode().then(() => [img.naturalWidth, img.naturalHeight]));
  expect(shown).toEqual([300, 300]);
  expect(jpegInfo(fake.photoOf(uid)).width).toBe(300);
});
