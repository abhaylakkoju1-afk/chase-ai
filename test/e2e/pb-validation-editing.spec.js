// Wall of Records: strict time validation and correct PB editing.
//
// Every typed time (new or edited) goes through one parser: seconds
// ("28.45") or minutes:seconds ("1:05.32", and "1:5.32" saved as "1:05.32"),
// up to two decimal places, at least 1.00 second. A rejected time shows the
// inline error and changes nothing. Older saved times that aren't valid are
// left as they are, flagged on the list, and can be corrected with Edit or
// deleted.
//
// Edit corrects the row's best-time swim in place: the swim's time (and the
// row's event/course) change, every other swim in the history is kept, and
// the best is recalculated from the history. Edit never adds a record; moving
// a row onto an event/course that already has one merges the two. Editing is
// turned off while the list belongs to a signed-in account, because account
// sync can't yet change a time it has already stored.

import { test, expect } from "@playwright/test";

const SAVE = "button[onclick='savePB()']";

async function dismissEntryGate(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

async function openPB(page) {
  await page.goto("/");
  await dismissEntryGate(page);
  await page.evaluate(() => window.showPage("pb"));
  await expect(page.locator("#pb")).toBeVisible();
}

// With an account marker set, the list stays hidden until the account code
// confirms that account is signed in on this page; this does what it does
// (saved-data-check.js accountMask.signedIn).
async function confirmSignedIn(page, marker, uid) {
  await expect(page.locator("#pbList .saved-data-hidden-note")).toBeVisible();
  await expect(page.locator("#savedDataStorageAlert")).toHaveAttribute("data-step", "not-here");
  await page.evaluate(([m, u]) => window.swimticsSavedData.accountMask.signedIn(m, u), [marker, uid]);
  await expect(page.locator("#pbList .saved-data-hidden-note")).toHaveCount(0);
  await expect(page.locator("#savedDataStorageAlert")).toHaveCount(0);
}

// Seeds the PB list once (an init script that leaves later changes alone).
async function seed(page, pbs) {
  await page.addInitScript((list) => {
    if (localStorage.getItem("pbs") === null) localStorage.setItem("pbs", JSON.stringify(list));
  }, pbs);
}

const stored = (page) => page.evaluate(() => localStorage.getItem("pbs"));
const storedList = async (page) => JSON.parse(await stored(page));
const rows = (page) => page.locator("#pbList .pb-title");

async function enter(page, { event, course, time }) {
  if (event) await page.locator("#event").selectOption(event);
  if (course) await page.locator("#course").selectOption(course);
  await page.locator("#time").fill(time);
  await page.locator(SAVE).click();
}

const FREE50 = { event: "Freestyle 50m", course: "Long Course" };

// One test per value: each Save PB click waits for the page's smooth
// scrolling and the button's hover transition to settle (about 1-2 s), so
// a loop of many values in one test ran close to the 30 s test timeout.
test.describe("time validation", () => {
  const ACCEPTED = [
    // [event, typed, saved text, seconds]
    ["Freestyle 50m", "28.45", "28.45", 28.45],
    ["Freestyle 100m", "1:05.32", "1:05.32", 65.32],
    ["Freestyle 200m", "2:05", "2:05", 125],
    ["Backstroke 100m", "65", "65", 65],
    ["Backstroke 50m", "31.4", "31.4", 31.4],
    ["Butterfly 50m", " 29.10 ", "29.10", 29.1],
    ["IM 400m", "4:59.99", "4:59.99", 299.99],
    ["Breaststroke 100m", "1:5.32", "1:05.32", 65.32],
    ["Breaststroke 200m", "2:5", "2:05", 125],
    ["Butterfly 100m", "1.00", "1.00", 1],
  ];
  for (const [event, typed, saved, seconds] of ACCEPTED) {
    test(`accepted: ${JSON.stringify(typed)} is saved as ${JSON.stringify(saved)}, with the history in seconds`, async ({ page }) => {
      await openPB(page);
      await enter(page, { event, course: "Long Course", time: typed });
      await expect(page.locator("#pbTimeError")).toBeHidden();
      expect(await storedList(page)).toEqual([{ event, course: "Long Course", time: saved, history: [seconds] }]);
      await expect(rows(page)).toHaveText([`${event} (Long Course) - ${saved}`]);
      await expect(page.locator("#pbList .pb-invalid-note")).toHaveCount(0);
    });
  }

  const MALFORMED = ["-5", "0", "0.00", "0:00.00", "0.99", "0:00.99", "1:65.00", "1:60", "28.4x", "99:99", "1:05:32", "28.456", "1:5.321", "28,45", ".45", "abc", "", "1e3", "Infinity"];
  for (const bad of MALFORMED) {
    test(`malformed: ${JSON.stringify(bad)} shows the inline error and changes nothing`, async ({ page }) => {
      await seed(page, [{ ...FREE50, time: "28.00", history: [28] }]);
      await openPB(page);
      const before = await stored(page);
      const error = page.locator("#pbTimeError");

      await enter(page, { ...FREE50, time: bad });
      await expect(error).toBeVisible();
      await expect(error).toHaveText("Enter a time of at least 1 second, as seconds (28.45) or minutes:seconds (1:05.32), with up to two decimal places, then Save PB.");
      await expect(page.locator("#time")).toHaveAttribute("aria-invalid", "true");
      expect(await stored(page)).toBe(before);
      await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 28.00"]);
    });
  }

  test("after a rejected time, a valid one clears the error and saves", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "28.00", history: [28] }]);
    await openPB(page);
    const error = page.locator("#pbTimeError");
    const time = page.locator("#time");

    await enter(page, { ...FREE50, time: "1:65.00" });
    await expect(error).toBeVisible();

    await enter(page, { ...FREE50, time: "27.50" });
    await expect(error).toBeHidden();
    await expect(time).not.toHaveAttribute("aria-invalid", "true");
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 27.50"]);
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "27.50", history: [28, 27.5] }]);
  });

  test("adding still works as before: a faster time becomes the best, a slower one is kept in the history", async ({ page }) => {
    await openPB(page);
    await enter(page, { ...FREE50, time: "30.00" });
    await enter(page, { ...FREE50, time: "29.00" });
    await enter(page, { ...FREE50, time: "31.00" });
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 29.00"]);
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "29.00", history: [30, 29, 31] }]);
  });
});

test.describe("editing", () => {
  test("Edit loads the best time and says what will happen; Cancel leaves everything as it was", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "25.00", history: [26.1, 25, 27.3] }]);
    await openPB(page);
    const cancel = page.locator("#pbCancelEdit");
    const status = page.locator("#pbEditStatus");
    await expect(cancel).toBeHidden();
    await expect(status).toBeHidden();

    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(page.locator("#time")).toHaveValue("25.00");
    await expect(page.locator("#time")).toBeFocused();
    await expect(page.locator("#event")).toHaveValue("Freestyle 50m");
    await expect(page.locator("#course")).toHaveValue("Long Course");
    await expect(status).toHaveText("Editing Freestyle 50m (Long Course), 25.00. Change the event, course or time, then Save PB. The other times in its history are kept.");
    await expect(cancel).toBeVisible();

    const before = await stored(page);
    await cancel.click();
    await expect(cancel).toBeHidden();
    await expect(status).toBeHidden();
    await expect(page.locator("#time")).toHaveValue("");
    expect(await stored(page)).toBe(before);

    // after Cancel, Save PB adds again
    await enter(page, { ...FREE50, time: "24.00" });
    expect((await storedList(page))[0]).toEqual({ ...FREE50, time: "24.00", history: [26.1, 25, 27.3, 24] });
  });

  test("editing the best to a slower time corrects that swim in place, and an earlier swim becomes the best", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "25.00", history: [26.1, 25, 27.3] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "28.00" });

    // same record, same history length and order; only the edited swim changed
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "26.10", history: [26.1, 28, 27.3] }]);
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 26.10"]);
    await expect(page.locator("#pbEditStatus")).toHaveText("Updated Freestyle 50m (Long Course). Best time: 26.10.");
    await expect(page.locator("#pbCancelEdit")).toBeHidden();
  });

  test("editing the best to a faster time keeps the typed time as the best", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "1:05.00", history: [66, 65, 67] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "1:04.20" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "1:04.20", history: [66, 64.2, 67] }]);
  });

  test("an edited time with a one-digit seconds part is saved padded", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "1:05.00", history: [66, 65, 67] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "1:4.20" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "1:04.20", history: [66, 64.2, 67] }]);
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 1:04.20"]);
  });

  test("a historical swim that matches the edited time keeps its own entry; nothing is added or lost", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "25.00", history: [25.5, 26, 25] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "26.00" });
    // the historical 25.50 becomes the best; the historical 26.00 is untouched next to the edited swim
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "25.50", history: [25.5, 26, 26] }]);
  });

  test("changing the event or course moves the same row, in place, with its whole history", async ({ page }) => {
    await seed(page, [
      { event: "Butterfly 100m", course: "Short Course", time: "1:02.00", history: [62] },
      { ...FREE50, time: "25.00", history: [26, 25] },
      { event: "IM 200m", course: "Long Course", time: "2:20.00", history: [140] },
    ]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await enter(page, { event: "Freestyle 100m", course: "Short Course", time: "25.00" });

    expect(await storedList(page)).toEqual([
      { event: "Butterfly 100m", course: "Short Course", time: "1:02.00", history: [62] },
      { event: "Freestyle 100m", course: "Short Course", time: "25.00", history: [26, 25] },
      { event: "IM 200m", course: "Long Course", time: "2:20.00", history: [140] },
    ]);
    await expect(rows(page)).toHaveCount(3);
  });

  test("moving a row onto an event/course that already has one merges them instead of adding a record", async ({ page }) => {
    await seed(page, [
      { event: "Freestyle 50m", course: "Short Course", time: "24.00", history: [24.5, 24] },
      { ...FREE50, time: "25.00", history: [26, 25] },
    ]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await enter(page, { course: "Short Course", time: "23.80" });

    expect(await storedList(page)).toEqual([
      { event: "Freestyle 50m", course: "Short Course", time: "23.80", history: [24.5, 24, 26, 23.8] },
    ]);
    await expect(rows(page)).toHaveText(["Freestyle 50m (Short Course) - 23.80"]);
  });

  test("an invalid time during an edit changes nothing and keeps the edit open on the same record", async ({ page }) => {
    await seed(page, [
      { event: "Butterfly 100m", course: "Short Course", time: "1:02.00", history: [62] },
      { ...FREE50, time: "25.00", history: [26, 25] },
    ]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(1)']").click();
    const before = await stored(page);

    for (const bad of ["1:65.00", "-5", "0", "0.99"]) {
      await enter(page, { time: bad });
      await expect(page.locator("#pbTimeError"), bad).toBeVisible();
      expect(await stored(page), bad).toBe(before);
      await expect(page.locator("#pbCancelEdit")).toBeVisible();
    }

    await enter(page, { time: "25.40" });
    expect(await storedList(page)).toEqual([
      { event: "Butterfly 100m", course: "Short Course", time: "1:02.00", history: [62] },
      { ...FREE50, time: "25.40", history: [26, 25.4] },
    ]);
  });

  test("Edit still targets the chosen record after another row is deleted and the list re-renders", async ({ page }) => {
    await seed(page, [
      { event: "Butterfly 100m", course: "Short Course", time: "1:02.00", history: [62] },
      { ...FREE50, time: "25.00", history: [26, 25] },
    ]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await page.locator("#pbList button[onclick='deletePB(0)']").click();   // the row above it
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 25.00"]);
    await expect(page.locator("#pbCancelEdit")).toBeVisible();

    await enter(page, { time: "25.20" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "25.20", history: [26, 25.2] }]);
  });

  test("deleting the row being edited ends the edit, so the next save adds instead of resurrecting it", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "25.00", history: [26, 25] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await page.locator("#pbList button[onclick='deletePB(0)']").click();
    await expect(page.locator("#pbCancelEdit")).toBeHidden();

    await enter(page, { ...FREE50, time: "27.00" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "27.00", history: [27] }]);
  });

  test("an older record with no history can be edited", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "30.00" }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "29.50" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "29.50", history: [29.5] }]);
  });

  test("an older record with no history and an unreadable time can be corrected with Edit", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "abc" }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(page.locator("#time")).toHaveValue("abc");
    await enter(page, { time: "30.10" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "30.10", history: [30.1] }]);
    await expect(page.locator("#pbList .pb-invalid-note")).toHaveCount(0);
  });

  test("edits persist after a reload", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "25.00", history: [26.1, 25] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "27.00" });
    await openPB(page);
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 26.10"]);
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "26.10", history: [26.1, 27] }]);
  });

  test("while the list belongs to a signed-in account, Edit explains it isn't available and changes nothing", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "25.00", history: [26, 25] }]);
    // the marker the Supabase account code sets while the working copy is an account's
    await page.addInitScript(() => localStorage.setItem("swimtics:sb:activeUid", "user-1"));
    await openPB(page);
    const before = await stored(page);
    await confirmSignedIn(page, "swimtics:sb:activeUid", "user-1");

    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(page.locator("#pbEditStatus")).toHaveText("Editing a saved time isn't available while you're signed in yet. You can still add a new time or delete a PB.");
    await expect(page.locator("#pbCancelEdit")).toBeHidden();
    await expect(page.locator("#time")).toHaveValue("");
    expect(await stored(page)).toBe(before);

    // Save PB still adds, as before
    await enter(page, { ...FREE50, time: "24.50" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "24.50", history: [26, 25, 24.5] }]);
  });
});

test.describe("older saved times that aren't valid", () => {
  const LEGACY = [
    { event: "Freestyle 50m", course: "Long Course", time: "-5", history: [-5] },
    { event: "Freestyle 100m", course: "Long Course", time: "abc", history: [null] },
    { event: "Backstroke 50m", course: "Long Course", time: "28.456", history: [28.456] },
    { event: "Butterfly 50m", course: "Long Course", time: "0.50", history: [0.5] },
    { event: "IM 200m", course: "Long Course", time: "1:65.00", history: [125] },
    { event: "Breaststroke 100m", course: "Long Course", time: "1:5.32", history: [65.32] }, // valid now; not rewritten
    { event: "Freestyle 200m", course: "Long Course", time: "2:05.00", history: [125] },
  ];

  test("are shown exactly as saved, flagged, and never rewritten or removed", async ({ page }) => {
    await seed(page, LEGACY);
    await openPB(page);
    expect(await stored(page)).toBe(JSON.stringify(LEGACY));

    // valid times are shown in saved form ("1:5.32" as "1:05.32"); invalid ones exactly as saved
    await expect(page.locator("#pbList .pb-time")).toHaveText(LEGACY.map((pb) => (pb.time === "1:5.32" ? "1:05.32" : pb.time)));
    const flagged = await rows(page).evaluateAll((titles) => titles.map((t) => !!t.querySelector(".pb-invalid-note")));
    expect(flagged).toEqual([true, true, true, true, true, false, false]);
    await expect(page.locator("#pbList .pb-invalid-note").first()).toHaveText("This saved time isn't valid. Use Edit to correct it, or Delete.");

    // a reload, and adding a time to another event, leave them as they were
    await openPB(page);
    await enter(page, { event: "IM 400m", course: "Long Course", time: "5:00.00" });
    expect((await storedList(page)).slice(0, LEGACY.length)).toEqual(LEGACY);
    await expect(page.locator("#pbList .pb-invalid-note")).toHaveCount(5);
  });

  test("valid older times with a one-digit seconds part are shown padded on the list, the edit form and the stroke cards, without rewriting storage", async ({ page }) => {
    const saved = [
      { event: "Freestyle 100m", course: "Long Course", time: "1:5.32", history: [66, 65.32] },
      { event: "Butterfly 200m", course: "Short Course", time: "2:9", history: [129] },
      { event: "Freestyle 50m", course: "Long Course", time: "28.4", history: [28.4] },     // already in saved form: unchanged
      { event: "Backstroke 50m", course: "Long Course", time: "-5", history: [-5] },        // invalid: exactly as saved
    ];
    await seed(page, saved);

    for (const visit of ["first visit", "after reload"]) {
      await openPB(page);
      await expect(page.locator("#pbList .pb-time"), visit).toHaveText(["1:05.32", "2:09", "28.4", "-5"]);
      expect(await stored(page), visit).toBe(JSON.stringify(saved));

      await page.evaluate(() => window.showPage("profile"));
      const times = page.locator("#strokeCards .stroke-times");
      await expect(times.nth(0), visit).toHaveText("50m: 28.4\n100m: 1:05.32\n200m: --", { useInnerText: true });
      await expect(times.nth(1), visit).toHaveText("50m: -5\n100m: --\n200m: --", { useInnerText: true });
      await expect(times.nth(3), visit).toHaveText("50m: --\n100m: --\n200m: 2:09", { useInnerText: true });
      expect(await stored(page), visit).toBe(JSON.stringify(saved));
    }

    // Edit shows the padded form; cancelling still changes nothing
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(page.locator("#time")).toHaveValue("1:05.32");
    await expect(page.locator("#pbEditStatus")).toContainText("Editing Freestyle 100m (Long Course), 1:05.32.");
    await page.locator("#pbCancelEdit").click();
    expect(await stored(page)).toBe(JSON.stringify(saved));
  });

  test("when a user's edit keeps an older one-digit-seconds best, it is saved padded", async ({ page }) => {
    await seed(page, [
      { event: "Freestyle 100m", course: "Short Course", time: "1:5.32", history: [65.32] },
      { event: "Freestyle 100m", course: "Long Course", time: "1:10.00", history: [70] },
    ]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await enter(page, { course: "Short Course", time: "1:09.00" });   // merges into the row whose best is 1:5.32
    expect(await storedList(page)).toEqual([
      { event: "Freestyle 100m", course: "Short Course", time: "1:05.32", history: [65.32, 69] },
    ]);
  });

  test("Edit says the saved time isn't valid, refuses it unchanged, and corrects only that swim", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "-5", history: [26, -5, 27] }]);
    await openPB(page);
    const before = await stored(page);

    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(page.locator("#time")).toHaveValue("-5");
    await expect(page.locator("#pbEditStatus")).toHaveText("Editing Freestyle 50m (Long Course). Its saved time, -5, isn't valid. Enter the correct time, then Save PB, or delete this PB. The other times in its history are kept.");

    // saving the invalid value unchanged is refused, and nothing changes
    await page.locator(SAVE).click();
    await expect(page.locator("#pbTimeError")).toBeVisible();
    await expect(page.locator("#pbCancelEdit")).toBeVisible();
    expect(await stored(page)).toBe(before);

    await enter(page, { time: "25.40" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "25.40", history: [26, 25.4, 27] }]);
    await expect(rows(page)).toHaveText(["Freestyle 50m (Long Course) - 25.40"]);
    await expect(page.locator("#pbList .pb-invalid-note")).toHaveCount(0);
  });

  test("a correction with a one-digit seconds part is saved padded; other unusable swims are kept but never become the best", async ({ page }) => {
    await seed(page, [{ event: "IM 200m", course: "Long Course", time: "1:65.00", history: [null, 130, 0.5] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await enter(page, { time: "2:5.10" });
    // the first unusable swim is the one corrected; the others stay as saved
    expect(await storedList(page)).toEqual([{ event: "IM 200m", course: "Long Course", time: "2:05.10", history: [125.1, 130, 0.5] }]);
  });

  test("can be deleted", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "abc", history: [null] }, { event: "IM 200m", course: "Long Course", time: "2:20.00", history: [140] }]);
    await openPB(page);
    await page.locator("#pbList button[onclick='deletePB(0)']").click();
    expect(await storedList(page)).toEqual([{ event: "IM 200m", course: "Long Course", time: "2:20.00", history: [140] }]);
    await expect(page.locator("#pbList .pb-invalid-note")).toHaveCount(0);
  });
});

test.describe("adding to a PB whose saved time isn't valid", () => {
  const blocked = (page) => page.locator("#pbBlockedError");
  const guestMessage = (name, time) =>
    `${name} has a saved time that isn't valid (${time}), so another time can't be added to it. Correct that time with Edit, or delete that PB, first. Nothing was saved.`;

  test("is refused with an inline message, and nothing is saved, overwritten or converted", async ({ page }) => {
    await seed(page, [
      { ...FREE50, time: "-5", history: [26, -5] },
      { event: "Freestyle 100m", course: "Long Course", time: "abc" },                // no history
      { event: "IM 200m", course: "Long Course", time: "2:20.00", history: [140] },
    ]);
    await openPB(page);
    const before = await stored(page);

    for (const [target, name, time] of [
      [{ ...FREE50, time: "25.00" }, "Freestyle 50m (Long Course)", "-5"],
      [{ event: "Freestyle 100m", course: "Long Course", time: "59.00" }, "Freestyle 100m (Long Course)", "abc"],
    ]) {
      await enter(page, target);
      await expect(blocked(page), name).toBeVisible();
      await expect(blocked(page)).toHaveText(guestMessage(name, time));
      await expect(page.locator("#pbTimeError")).toBeHidden();       // the time itself was fine
      expect(await stored(page), name).toBe(before);
    }
    await expect(page.locator("#pbList .pb-time")).toHaveText(["-5", "abc", "2:20.00"]);

    // a valid PB still takes a new time, and the message goes away
    await enter(page, { event: "IM 200m", course: "Long Course", time: "2:18.00" });
    await expect(blocked(page)).toBeHidden();
    expect((await storedList(page))[2]).toEqual({ event: "IM 200m", course: "Long Course", time: "2:18.00", history: [140, 138] });
    expect((await storedList(page)).slice(0, 2)).toEqual(JSON.parse(before).slice(0, 2));
  });

  test("works again once the saved time is corrected with Edit", async ({ page }) => {
    await seed(page, [{ ...FREE50, time: "-5", history: [26, -5] }]);
    await openPB(page);
    await enter(page, { ...FREE50, time: "25.00" });
    await expect(blocked(page)).toBeVisible();

    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(blocked(page)).toBeHidden();
    await enter(page, { time: "25.80" });
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "25.80", history: [26, 25.8] }]);

    await enter(page, { ...FREE50, time: "25.00" });
    await expect(blocked(page)).toBeHidden();
    expect(await storedList(page)).toEqual([{ ...FREE50, time: "25.00", history: [26, 25.8, 25] }]);
  });

  test("moving an edit onto it is refused too, and the edit stays open with nothing changed", async ({ page }) => {
    await seed(page, [
      { event: "Freestyle 50m", course: "Short Course", time: "0.50", history: [0.5] },
      { ...FREE50, time: "25.00", history: [26, 25] },
    ]);
    await openPB(page);
    const before = await stored(page);
    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await enter(page, { course: "Short Course", time: "24.00" });

    await expect(blocked(page)).toHaveText(guestMessage("Freestyle 50m (Short Course)", "0.50"));
    expect(await stored(page)).toBe(before);
    await expect(page.locator("#pbCancelEdit")).toBeVisible();

    // the same edit, kept on its own course, saves
    await enter(page, { course: "Long Course", time: "24.00" });
    await expect(blocked(page)).toBeHidden();
    expect(await storedList(page)).toEqual([
      { event: "Freestyle 50m", course: "Short Course", time: "0.50", history: [0.5] },
      { ...FREE50, time: "24.00", history: [26, 24] },
    ]);
  });

  test("signed in, the messages say Edit isn't available and offer only Delete", async ({ page }) => {
    await seed(page, [
      { ...FREE50, time: "-5", history: [26, -5] },
      { event: "IM 200m", course: "Long Course", time: "2:20.00", history: [140] },
    ]);
    await page.addInitScript(() => localStorage.setItem("swimtics:sb:activeUid", "user-1"));
    await openPB(page);
    const before = await stored(page);
    await confirmSignedIn(page, "swimtics:sb:activeUid", "user-1");

    await expect(page.locator("#pbList .pb-invalid-note")).toHaveText(
      ["This saved time isn't valid. Editing isn't available while you're signed in yet; you can Delete this PB."]);

    await enter(page, { ...FREE50, time: "25.00" });
    await expect(blocked(page)).toHaveText("Freestyle 50m (Long Course) has a saved time that isn't valid (-5), so another time can't be added to it. Editing isn't available while you're signed in yet; you can delete that PB (its other times are deleted with it). Nothing was saved.");
    expect(await stored(page)).toBe(before);

    await page.locator("#pbList button[onclick='editPB(0)']").click();
    await expect(page.locator("#pbEditStatus")).toHaveText("Editing a saved time isn't available while you're signed in yet, and this PB can't take another time while its saved time isn't valid. You can delete this PB (its other times are deleted with it).");
    await expect(page.locator("#pbCancelEdit")).toBeHidden();

    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await expect(page.locator("#pbEditStatus")).toHaveText("Editing a saved time isn't available while you're signed in yet. You can still add a new time or delete a PB.");
    expect(await stored(page)).toBe(before);
  });
});

test.describe("saved history entries that aren't valid", () => {
  // Chart.js comes from a CDN; this stand-in records what would be plotted
  async function stubChart(page) {
    await page.route("**/npm/chart.js", (route) => route.fulfill({
      contentType: "text/javascript",
      body: "window.__charts = []; window.Chart = class { constructor(ctx, config) { this.ctx = ctx; this.config = config; window.__charts.push(config); } destroy() {} };",
    }));
  }

  test("are listed under the chart as saved, and left off the chart; storage is unchanged", async ({ page }) => {
    const saved = [
      { ...FREE50, time: "26.00", history: [27, -5, null, 0.5, 28.456, 26] },
      { event: "IM 200m", course: "Long Course", time: "2:20.00", history: [141, 140] },
    ];
    await stubChart(page);
    await seed(page, saved);
    await openPB(page);

    await page.locator("#pbList button[onclick='toggleChart(0)']").click();
    const box = page.locator("#chart-container-0 .pb-invalid-history");
    await expect(box).toBeVisible();
    await expect(box.locator(".pb-invalid-history-title")).toHaveText("Not shown on the chart: these saved times aren't valid.");
    await expect(box.locator("li")).toHaveText([
      "Attempt 2: saved as -5",
      "Attempt 3: the saved value can't be read",
      "Attempt 4: saved as 0.5",
      "Attempt 5: saved as 28.456",
    ]);
    const plotted = await page.evaluate(() => window.__charts.at(-1).data);
    expect(plotted.labels).toEqual(["Attempt 1", "Attempt 2", "Attempt 3", "Attempt 4", "Attempt 5", "Attempt 6"]);
    expect(plotted.datasets[0].data).toEqual([27, null, null, null, null, 26]);

    // a PB with only valid swims has no such list, and is plotted as before
    await page.locator("#pbList button[onclick='toggleChart(1)']").click();
    await expect(page.locator("#chart-container-1 .pb-invalid-history")).toHaveCount(0);
    expect(await page.evaluate(() => window.__charts.at(-1).data.datasets[0].data)).toEqual([141, 140]);

    expect(await stored(page)).toBe(JSON.stringify(saved));
    await openPB(page);
    expect(await stored(page)).toBe(JSON.stringify(saved));
  });
});
