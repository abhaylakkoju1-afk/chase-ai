// The tools say what to do: instructions, field labels and feedback
// (the first round of the page-clarity audit). Each test checks what a
// swimmer sees or what a screen reader announces, not internal state.

import { test, expect } from "@playwright/test";

async function dismissEntryGate(page) {
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
}

async function open(page, id) {
  await page.goto("/");
  await dismissEntryGate(page);
  await page.evaluate((p) => window.showPage(p), id);
  await expect(page.locator(`#${id}`)).toBeVisible();
}

test.describe("Homepage", () => {
  test("the Chase card describes what Chase measures, with no efficiency score", async ({ page }) => {
    await page.goto("/");
    const desc = page.locator("#feature-chase-desc");
    await expect(desc).toContainText("Chase measures body alignment, arm symmetry and joint angles");
    await expect(desc).not.toContainText("efficiency score");
  });
});

test.describe("Chase AI", () => {
  test("says what to do first, labels the stroke menu and lists the steps in page order", async ({ page }) => {
    await open(page, "analyzer");
    await expect(page.locator("#analyzer .tool-hint")).toHaveText("Upload a swim video, choose the stroke, then press Analyze.");
    await expect(page.getByLabel("Stroke", { exact: true })).toHaveAttribute("id", "stroke");
    await expect(page.locator("#analyzer .howto-card h4")).toHaveText([
      "Upload Your Video", "Choose the Stroke", "Press Analyze", "Review Your Results",
    ]);
  });

  test("the report buttons that don't work yet are hidden", async ({ page }) => {
    await open(page, "analyzer");
    await expect(page.locator("button[onclick='saveAnalysisReport()']")).toBeHidden();
    await expect(page.locator("button[onclick='loadSavedReports()']")).toBeHidden();
    await expect(page.locator("button[onclick='upload()']")).toBeVisible();
  });

  test("status messages say what happened and what to do next", async ({ page }) => {
    await open(page, "analyzer");
    const status = page.locator("#chaseStatus");
    // set when the pose engine is ready (or, offline, says it didn't load)
    await expect(status).toHaveText(/^● (Ready\. Upload a swim video to begin\.|The analysis engine didn't load\. Check your connection and reload the page\.)$/);
    const bad = await page.evaluate(() => {
      setChaseStatus("Couldn't see the swimmer clearly enough. Try a steady, side-on clip with the whole body in view.", "error");
      return document.getElementById("chaseStatus").dataset.kind;
    });
    expect(bad).toBe("error");
  });
});

test.describe("Wall of Records", () => {
  test("fields are labelled, and an empty or unreadable time says why nothing was saved", async ({ page }) => {
    await open(page, "pb");
    await expect(page.locator("#pb").getByLabel("Event", { exact: true })).toHaveAttribute("id", "event");
    await expect(page.locator("#pb").getByLabel("Course", { exact: true })).toHaveAttribute("id", "course");
    const time = page.getByLabel("Your time (e.g. 1:05.32)");
    await expect(time).toHaveAttribute("id", "time");

    const error = page.locator("#pbTimeError");
    await expect(error).toBeHidden();

    await page.locator("button[onclick='savePB()']").click();
    await expect(error).toBeVisible();
    await expect(error).toHaveText("Enter a time like 28.45 or 1:05.32, then Save PB.");
    await expect(time).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#pbList .pb-item")).toHaveCount(0);

    await time.fill("abc");
    await page.locator("button[onclick='savePB()']").click();
    await expect(error).toBeVisible();
    await expect(page.locator("#pbList .pb-item")).toHaveCount(0);

    await time.fill("1:05.32");
    await page.locator("button[onclick='savePB()']").click();
    await expect(page.locator("#pbList .pb-item")).toHaveCount(1);
    await expect(error).toBeHidden();
    await expect(time).not.toHaveAttribute("aria-invalid", "true");
  });

  test("step 1 describes the fields that exist", async ({ page }) => {
    await open(page, "pb");
    await expect(page.locator("#pb .howto-card").first()).toContainText("Choose the event and course, enter your time, then Save PB.");
  });
});

test.describe("Chronos", () => {
  test("the how-to steps describe the video workflow", async ({ page }) => {
    await open(page, "race");
    const steps = page.locator("#race .howto-card p");
    await expect(steps).toHaveText([
      "Choose the event, course and pool length.",
      "Upload a video of the race.",
      "Pause just before the start, choose Mark Pre-Start Frame & Lane Position, then click the swimmer.",
      "Choose Start Automatic Analysis and review your splits.",
    ]);
    // the controls the steps name are on the page
    await expect(page.locator("#raceCalibrateBtn")).toContainText("Mark Pre-Start Frame & Lane Position");
    await expect(page.locator("#raceAutoStartBtn")).toContainText("Start Automatic Analysis");
  });
});

test.describe("Profile", () => {
  test("every field has a visible label, including date of birth", async ({ page }) => {
    await open(page, "profile");
    const fields = await page.locator(".profile-container input").evaluateAll((inputs) =>
      inputs.map((i) => ({ id: i.id, label: i.labels?.[0]?.innerText.trim() || "", visible: !!i.labels?.[0]?.offsetHeight })));
    expect(fields).toHaveLength(24);
    for (const f of fields) {
      expect(f.label, `#${f.id} has a label`).not.toBe("");
      expect(f.visible, `#${f.id}'s label is visible`).toBe(true);
    }
    await expect(page.getByLabel("Date of birth")).toHaveAttribute("id", "dob");
  });

  test("the intro no longer promises personalisation, and points to the form", async ({ page }) => {
    await open(page, "profile");
    await expect(page.locator("#profile .st-intro")).not.toContainText("personalized");
    await expect(page.locator("#profile .st-intro .tool-hint a")).toHaveAttribute("href", "#profileFormStart");
    await expect(page.locator("#profileFormStart")).toHaveText("Basic Info");
  });

  test("gender shows as unset until one is entered, and no default is written", async ({ page }) => {
    await open(page, "profile");
    await expect(page.locator("#gender")).toHaveValue("");
    await expect(page.locator("#strokeCards .stroke-meta").first()).toContainText("--");
    await expect(page.locator("#strokeCards")).not.toContainText("Male");

    await page.locator("#name").fill("No Gender Given");
    await page.locator("button[onclick='saveProfile()']").click();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("profile")));
    expect(stored.gender || "").toBe("");
  });

  test("an entered gender is still shown on the cards", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("profile", JSON.stringify({ name: "A", gender: "female" })));
    await open(page, "profile");
    await expect(page.locator("#gender")).toHaveValue("female");
    await expect(page.locator("#strokeCards .stroke-meta").first()).toContainText("♀ Female");
  });

  test("the photo box can be reached and opened from the keyboard", async ({ page }) => {
    await open(page, "profile");
    const box = page.locator("#profileImageBox");
    await expect(box).toHaveAttribute("role", "button");
    await expect(box).toHaveAttribute("tabindex", "0");
    await page.evaluate(() => { window.__photoOpened = 0; window.uploadProfileImage = () => { window.__photoOpened += 1; }; });
    await box.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    expect(await page.evaluate(() => window.__photoOpened)).toBe(2);
  });
});

test.describe("War Room", () => {
  test("each question's visible label names its field", async ({ page }) => {
    await open(page, "dashboard");
    for (const [label, id] of [
      ["Days Until Meet", "meetDays"], ["Fatigue Level", "fatigue"], ["Sleep Quality", "sleep"],
      ["Overall Soreness", "soreness"], ["Current Season", "season"], ["Race Type", "raceType"],
      ["Mental Readiness & Motivation", "mentalReadiness"],
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toHaveAttribute("id", id);
    }
  });
});

test.describe("Coach ATLAS", () => {
  test("opens with what it can help with, and its input and send button are named", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    // the consent notice sits over the bottom of the page until answered
    await page.locator("#consentBanner").getByRole("button", { name: "Decline" }).click();
    await page.locator("#aiCoachBtn").click();
    await expect(page.locator("#coachMessages")).toContainText("ATLAS gives general information, not analysis of your own videos.");
    await expect(page.getByRole("textbox", { name: "Message Coach ATLAS" })).toBeVisible();
    await page.getByRole("textbox", { name: "Message Coach ATLAS" }).fill("hello there");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("#coachMessages .coach-msg")).toHaveCount(3);
    await expect(page.locator("#coachMessages")).not.toContainText("advanced personalized coaching");
  });
});
