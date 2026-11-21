// Saved personal bests ("pbs") and Profile ("profile") that can't be read.
//
// Both are kept in localStorage. When the saved text isn't valid JSON, or
// is valid JSON in a shape the app never writes, the Wall of Records and
// Profile show a recovery message instead of crashing or quietly showing
// an empty list or blank profile. The saved text is never changed on page
// load: it stays exactly as it was until the person chooses Start fresh
// and confirms it, and writes that would replace it (Save PB, Edit,
// Delete, Save Profile, a new photo) are held back until then. The backup
// (download or copy) is the saved text exactly as it is. Start fresh
// removes only that one value from this browser, sends nothing anywhere,
// and isn't offered while the data belongs to a signed-in account.
// Valid saved data behaves as before.

import { test, expect } from "@playwright/test";

// Seeds raw localStorage values once per test (not again on reload).
async function seed(page, items) {
  await page.addInitScript((entries) => {
    if (sessionStorage.getItem("seeded")) return;
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    sessionStorage.setItem("seeded", "1");
  }, items);
}

// Fails the test on any uncaught page error, and records every request
// that could carry data to a server.
function watch(page) {
  const errors = [];
  const sent = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    const host = new URL(r.url()).hostname;
    if (r.method() !== "GET" || /firebaseio|firebasedatabase|supabase|identitytoolkit|securetoken/.test(host)) sent.push(`${r.method()} ${r.url()}`);
  });
  return { errors, sent };
}

async function open(page, id) {
  await page.goto("/");
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
  // the consent notice sits over the bottom of the page until answered
  await page.locator("#consentBanner").getByRole("button", { name: "Decline" }).click();
  await page.evaluate((p) => window.showPage(p), id);
  await expect(page.locator(`#${id}`)).toBeVisible();
}

const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

// The rest of index.html's main script ran (a malformed "pbs" used to stop
// it at its first line), and every page still opens.
async function expectPageUsable(page) {
  expect(await page.evaluate(() => [typeof upload, typeof generateChaseFeedback, typeof savePB, typeof loadProfile]))
    .toEqual(["function", "function", "function", "function"]);
  for (const id of ["home", "analyzer", "pb", "race", "profile", "dashboard"]) {
    await page.evaluate((p) => window.showPage(p), id);
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
}

const PB_CASES = [
  ["malformed JSON", '[{"event":"Freestyle 50m","course":"Long Course","time":"28.00"', /damaged: it isn't valid saved data/],
  ["an object, not a list", '{"event":"Freestyle 50m","course":"Long Course","time":"28.00"}', /isn't in the format SWIMTICS expects: it's an object, not a list of personal bests/],
  ["a PB with a numeric time", '[{"event":"Freestyle 50m","course":"Long Course","time":28,"history":[28]}]', /isn't in the format SWIMTICS expects: entry 1's time isn't text/],
  ["null", "null", /isn't in the format SWIMTICS expects: it's null, not a list of personal bests/],
];

const PROFILE_CASES = [
  ["malformed JSON", '{"name":"Sam","club":"Tigers"', /damaged: it isn't valid saved data/],
  ["a list, not a profile", '["Sam"]', /isn't in the format SWIMTICS expects: it's a list, not a profile/],
  ["a field that isn't text", '{"name":{"first":"Sam"},"club":"Tigers"}', /isn't in the format SWIMTICS expects: the "name" field is an object/],
  ["null", "null", /isn't in the format SWIMTICS expects: it's null, not a profile/],
];

const pbPanel = (page) => page.locator('#pbList .saved-data-recovery[data-saved-key="pbs"]');
const profilePanel = (page) => page.locator('#profileDataRecovery .saved-data-recovery[data-saved-key="profile"]');

for (const [label, raw, reason] of PB_CASES) {
  test.describe(`saved personal bests: ${label}`, () => {
    test("Wall of Records explains, keeps the saved value, and the site keeps working", async ({ page }) => {
      const w = watch(page);
      await seed(page, { pbs: raw });
      await open(page, "pb");

      const panel = pbPanel(page);
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Your saved personal bests can't be read" })).toBeVisible();
      await expect(panel).toContainText(reason);
      await expect(panel).toContainText("Nothing has been changed or deleted.");
      for (const name of ["Download a backup", "Copy backup", "Start fresh…"]) await expect(panel.getByRole("button", { name })).toBeVisible();
      await expect(page.locator("#pbEmpty")).toBeHidden();          // not presented as "no PBs yet"
      await expect(page.locator("#pbList .pb-item")).toHaveCount(0);

      // Profile: the stroke cards still draw, with no times, and say why
      await page.evaluate(() => window.showPage("profile"));
      await expect(page.locator("#strokeCards .stroke-card")).toHaveCount(4);
      await expect(page.locator("#strokeCards .stroke-times").first()).toHaveText(/50m: --\s*100m: --\s*200m: --/);
      const note = page.locator("#profileDataRecovery .saved-data-pbs-note");
      await expect(note).toContainText("Your saved personal bests can't be read, so the stroke cards show no times.");
      await note.getByRole("button", { name: "Go to Wall of Records" }).click();
      await expect(page.locator("#pb")).toBeVisible();

      await expectPageUsable(page);
      await page.reload();
      await expect(pbPanel(page)).toHaveCount(1);
      expect(await stored(page, "pbs")).toBe(raw);
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });

    test("Save PB is held back and changes nothing", async ({ page }) => {
      const w = watch(page);
      await seed(page, { pbs: raw });
      await open(page, "pb");
      await page.locator("#time").fill("27.50");
      await page.locator("button[onclick='savePB()']").click();
      await expect(page.locator("#pbBlockedError")).toBeVisible();
      await expect(page.locator("#pbBlockedError")).toHaveText(/^Your saved personal bests can't be read, so nothing can be added, edited or deleted yet\. Nothing was saved\./);
      // Edit and Delete (reachable from code) are held back the same way
      await page.evaluate(() => { editPB(0); deletePB(0); });
      expect(await stored(page, "pbs")).toBe(raw);
      expect(await page.evaluate(() => pbs.length)).toBe(0);
      await expect(pbPanel(page)).toBeVisible();
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });
  });
}

for (const [label, raw, reason] of PROFILE_CASES) {
  test.describe(`saved profile: ${label}`, () => {
    test("Profile explains, keeps the saved value, and the site keeps working", async ({ page }) => {
      const w = watch(page);
      await seed(page, { profile: raw });
      await open(page, "profile");

      const panel = profilePanel(page);
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "Your saved profile can't be read" })).toBeVisible();
      await expect(panel).toContainText(reason);
      await expect(panel).toContainText("Nothing has been changed or deleted.");
      for (const name of ["Download a backup", "Copy backup", "Start fresh…"]) await expect(panel.getByRole("button", { name })).toBeVisible();
      await expect(page.locator("#name")).toHaveValue("");
      await expect(page.locator("#strokeCards .stroke-card")).toHaveCount(4);
      await expect(page.locator("#profileDataRecovery .saved-data-pbs-note")).toHaveCount(0);

      await expectPageUsable(page);
      await page.reload();
      await page.evaluate(() => window.showPage("profile"));
      await expect(profilePanel(page)).toBeVisible();
      expect(await stored(page, "profile")).toBe(raw);
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });

    test("Save Profile and a new photo are held back and change nothing", async ({ page }) => {
      const w = watch(page);
      let pickers = 0;
      page.on("filechooser", () => { pickers += 1; });
      await seed(page, { profile: raw });
      await open(page, "profile");

      await page.locator("#name").fill("Alex");
      await page.locator("button[onclick='saveProfile()']").click();
      await expect(page.locator("#profileSaveStatus")).toHaveText("Your profile wasn't saved, because your saved profile can't be read. Save a backup or start fresh using the message at the top of Profile first.");
      await expect(page.locator("#profileSaveStatus")).toHaveAttribute("data-kind", "error");
      await expect(page.locator("#name")).toHaveValue("Alex");    // what was typed is kept

      await page.locator("#profileImageBox").click();
      await expect(page.locator("#profileSaveStatus")).toHaveText(/^The photo wasn't saved, because your saved profile can't be read\./);
      expect(pickers).toBe(0);

      expect(await stored(page, "profile")).toBe(raw);
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });
  });
}

// The backup and Start fresh actions, for both saved values.
const RECOVERY = [
  {
    key: "pbs", page: "pb", raw: '[{"event":"Freestyle 50m","course":"Long Course","time":"28.00","history":[28]}, {"event":',
    panel: pbPanel, file: /^swimtics-personal-bests-backup-\d{4}-\d{2}-\d{2}\.txt$/,
    done: "The unreadable personal bests were removed from this browser. Your PB list is now empty.",
    doneLine: "#pbEditStatus", focusAfter: "#event",
  },
  {
    key: "profile", page: "profile", raw: '{"name":"Sam","photo":"data:image/png;base64,AAAA","club":["Tigers"]}',
    panel: profilePanel, file: /^swimtics-profile-backup-\d{4}-\d{2}-\d{2}\.txt$/,
    done: "The unreadable profile was removed from this browser. Your profile is now blank.",
    doneLine: "#profileSaveStatus", focusAfter: "#name",
  },
];

for (const r of RECOVERY) {
  test.describe(`recovering the saved ${r.key}`, () => {
    test("Download a backup saves the saved text exactly, and changes nothing", async ({ page }) => {
      const w = watch(page);
      await seed(page, { [r.key]: r.raw });
      await open(page, r.page);
      const panel = r.panel(page);
      const [download] = await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download a backup" }).click()]);
      expect(download.suggestedFilename()).toMatch(r.file);
      const chunks = [];
      for await (const c of await download.createReadStream()) chunks.push(c);
      expect(Buffer.concat(chunks).toString("utf8")).toBe(r.raw);
      await expect(panel.locator(".saved-data-recovery-status")).toHaveText(`Backup downloaded as ${download.suggestedFilename()}. Keep it somewhere safe.`);
      expect(await stored(page, r.key)).toBe(r.raw);
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });

    test("Copy backup puts the saved text on the clipboard, and changes nothing", async ({ page, context }) => {
      const w = watch(page);
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await seed(page, { [r.key]: r.raw });
      await open(page, r.page);
      const panel = r.panel(page);
      await panel.getByRole("button", { name: "Copy backup" }).click();
      await expect(panel.locator(".saved-data-recovery-status")).toHaveText("Backup copied. Paste it somewhere safe, such as a note, before you start fresh.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(r.raw);
      expect(await stored(page, r.key)).toBe(r.raw);
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });

    test("Start fresh asks first; Cancel changes nothing; confirming removes only that value", async ({ page }) => {
      const w = watch(page);
      const other = r.key === "pbs" ? "profile" : "pbs";
      const otherRaw = r.key === "pbs" ? '{"name":"Kept"}' : '[{"event":"Freestyle 100m","course":"Short Course","time":"1:00.00","history":[60]}]';
      await seed(page, { [r.key]: r.raw, [other]: otherRaw, strokeData: '{"freestyle":{}}' });
      await open(page, r.page);
      const panel = r.panel(page);
      const confirmYes = panel.getByRole("button", { name: "Remove and start fresh" });

      await panel.getByRole("button", { name: "Start fresh…" }).click();
      await expect(confirmYes).toBeVisible();
      await expect(confirmYes).toBeFocused();
      await expect(panel.locator(".saved-data-recovery-confirm")).toContainText("This can't be undone. You haven't downloaded or copied a backup yet.");
      expect(await stored(page, r.key)).toBe(r.raw);

      await panel.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmYes).toBeHidden();
      await expect(panel.locator(".saved-data-recovery-status")).toHaveText("Nothing was changed.");
      expect(await stored(page, r.key)).toBe(r.raw);

      // after a backup, the confirmation no longer warns about it
      await Promise.all([page.waitForEvent("download"), panel.getByRole("button", { name: "Download a backup" }).click()]);
      await panel.getByRole("button", { name: "Start fresh…" }).click();
      await expect(panel.locator(".saved-data-recovery-confirm")).not.toContainText("You haven't downloaded or copied a backup yet.");
      await confirmYes.click();

      expect(await stored(page, r.key)).toBeNull();
      expect(await stored(page, other)).toBe(otherRaw);                   // nothing else touched
      expect(await stored(page, "strokeData")).toBe('{"freestyle":{}}');
      await expect(r.panel(page)).toHaveCount(0);
      await expect(page.locator(r.doneLine)).toHaveText(r.done);
      await expect(page.locator(r.focusAfter)).toBeFocused();

      // and the page works normally from empty
      if (r.key === "pbs") {
        await expect(page.locator("#pbEmpty")).toBeVisible();
        await expect(page.locator("#pbBlockedError")).toBeHidden();
        await page.locator("#time").fill("27.50");
        await page.locator("button[onclick='savePB()']").click();
        expect(JSON.parse(await stored(page, "pbs"))).toEqual([{ event: "Freestyle 50m", course: "Short Course", time: "27.50", history: [27.5] }]);
        await expect(page.locator("#pbList .pb-item")).toHaveCount(1);
      } else {
        await page.locator("#name").fill("Alex");
        await page.locator("button[onclick='saveProfile()']").click();
        await expect(page.locator("#profileSaveStatus")).toHaveText("Saved on this device.");
        expect(JSON.parse(await stored(page, "profile"))).toMatchObject({ name: "Alex" });
        await expect(page.locator("#displayName")).toHaveText("Alex");
      }
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });

    test("Start fresh refuses if the saved value changed since the message appeared", async ({ page }) => {
      await seed(page, { [r.key]: r.raw });
      await open(page, r.page);
      const panel = r.panel(page);
      await panel.getByRole("button", { name: "Start fresh…" }).click();
      await page.evaluate((k) => localStorage.setItem(k, "changed elsewhere"), r.key);
      await panel.getByRole("button", { name: "Remove and start fresh" }).click();
      await expect(panel.locator(".saved-data-recovery-status")).toHaveText("The saved data changed since this message appeared, so nothing was removed. Reload the page to see it.");
      expect(await stored(page, r.key)).toBe("changed elsewhere");
    });

    test("while the data belongs to a signed-in account, Start fresh isn't offered", async ({ page }) => {
      const w = watch(page);
      // the Supabase test-account marker: owned by an account, and (without
      // ?supabase) no account code runs to replace the working copy
      await seed(page, { [r.key]: r.raw, "swimtics-test:activeUid": '"user-1"' });
      await open(page, r.page);
      const panel = r.panel(page);
      await expect(panel).toContainText("You're signed in, so this copy belongs to your account. Starting fresh isn't available while you're signed in yet");
      await expect(panel.getByRole("button", { name: "Download a backup" })).toBeVisible();
      await expect(panel.getByRole("button", { name: "Copy backup" })).toBeVisible();
      await expect(panel.getByRole("button", { name: /Start fresh|Remove and start fresh/ })).toHaveCount(0);
      expect(await stored(page, r.key)).toBe(r.raw);
      expect(w.errors).toEqual([]);
      expect(w.sent).toEqual([]);
    });
  });
}

test.describe("valid saved data behaves as before", () => {
  const PBS = [
    { event: "Freestyle 50m", course: "Long Course", time: "28.45", history: [29.1, 28.45] },
    { event: "Freestyle 100m", course: "Short Course", time: "1:5.32", history: [65.32] },
  ];
  const PROFILE = { name: "Sam", gender: "female", club: "Tigers", height: "172", shortGoal: "Sub 28" };

  test("PBs and profile load as saved, with no recovery message and no writes", async ({ page }) => {
    const w = watch(page);
    const pbsRaw = JSON.stringify(PBS);
    const profileRaw = JSON.stringify(PROFILE);
    await seed(page, { pbs: pbsRaw, profile: profileRaw });
    await open(page, "pb");
    await expect(page.locator("#pbList .pb-title")).toHaveText(["Freestyle 50m (Long Course) - 28.45", "Freestyle 100m (Short Course) - 1:05.32"]);
    await expect(page.locator(".saved-data-recovery")).toHaveCount(0);

    await page.evaluate(() => window.showPage("profile"));
    await expect(page.locator("#name")).toHaveValue("Sam");
    await expect(page.locator("#club")).toHaveValue("Tigers");
    await expect(page.locator("#displayName")).toHaveText("Sam");
    await expect(page.locator("#profileDataRecovery")).toBeEmpty();
    await expect(page.locator("#strokeCards .stroke-times").first()).toHaveText(/50m: 28\.45\s*100m: 1:05\.32/);

    expect(await stored(page, "pbs")).toBe(pbsRaw);
    expect(await stored(page, "profile")).toBe(profileRaw);
    expect(w.errors).toEqual([]);
  });

  test("Save PB and Save Profile work as before", async ({ page }) => {
    await seed(page, { pbs: JSON.stringify(PBS), profile: JSON.stringify(PROFILE) });
    await open(page, "pb");
    await page.locator("#event").selectOption("Freestyle 50m");
    await page.locator("#course").selectOption("Long Course");
    await page.locator("#time").fill("28.10");
    await page.locator("button[onclick='savePB()']").click();
    expect(JSON.parse(await stored(page, "pbs"))[0]).toEqual({ event: "Freestyle 50m", course: "Long Course", time: "28.10", history: [29.1, 28.45, 28.1] });

    await page.evaluate(() => window.showPage("profile"));
    await page.locator("#club").fill("Sharks");
    await page.locator("button[onclick='saveProfile()']").click();
    await expect(page.locator("#profileSaveStatus")).toHaveText("Saved on this device.");
    expect(JSON.parse(await stored(page, "profile"))).toMatchObject({ ...PROFILE, club: "Sharks" });
  });

  test("nothing saved: the empty states show and nothing is written", async ({ page }) => {
    const w = watch(page);
    await open(page, "pb");
    await expect(page.locator("#pbEmpty")).toBeVisible();
    await expect(page.locator(".saved-data-recovery")).toHaveCount(0);
    await page.evaluate(() => window.showPage("profile"));
    await expect(page.locator("#profileDataRecovery")).toBeEmpty();
    await expect(page.locator("#displayName")).toHaveText("Athlete Name");
    expect(await stored(page, "pbs")).toBeNull();
    expect(await stored(page, "profile")).toBeNull();
    expect(w.errors).toEqual([]);
  });
});
