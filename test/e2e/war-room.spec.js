// Regression tests for the War Room soreness body map and plan
// generation, covering the exact bug fixed here: a missing
// `let sorenessMap = {};` top-level declaration (dropped in a prior file
// reorganization, confirmed via `git log -S"sorenessMap"`) meant every
// reader/writer of it — cycleSoreness(), resetSorenessMap(), and
// generateWarRoomPlan()'s soreness loop — threw an uncaught
// ReferenceError the moment it ran, silently breaking body-part
// selection and aborting plan generation (caught by its own try/catch,
// surfaced only as "War Room generation failed. Check console.").
//
// Mirrors test/e2e/shell.spec.js's own conventions (dismissEntryGate
// helper, onclick-attribute locators, per-test browser context so
// localStorage never leaks between tests).

import { test, expect } from "@playwright/test";

async function dismissEntryGate(page) {
  const entryGate = page.locator("#entryGate");
  await page.locator("#enterButton").click();
  await entryGate.waitFor({ state: "hidden" });
}

/*
 * Navigate the way a user does with the site nav: Home is the brand
 * (logo + SWIMTICS) button; every other page is in the Tools menu.
 */
async function navigateTo(page, id) {
  if (id === "home") {
    await page.locator(".site-nav-brand").click();
    return;
  }
  await page.locator("#siteNavToolsButton").click();
  await page.locator(`#siteNavToolsMenu button[onclick="showPage('${id}')"]`).click();
}

async function openWarRoom(page) {
  await page.goto("/");
  await dismissEntryGate(page);
  await navigateTo(page, "dashboard");
  await expect(page.locator("#dashboard")).toBeVisible();
}

const UNSELECTED_FILL = "rgba(180, 190, 220, 0.16)";

test.describe("War Room — soreness body map", () => {
  test("War Room loads with the soreness map present and no console errors", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await openWarRoom(page);

    await expect(page.locator("#LeftShoulder")).toBeAttached();
    await expect(page.locator("svg path.body-part")).not.toHaveCount(0);
    // Scoped to the regression this file exists to catch — not a general
    // zero-console-errors assertion. The page has a separate, pre-existing,
    // unrelated bug (updateProfileAccountSection is not defined, fired on
    // every page load regardless of War Room) that shell.spec.js's own
    // header comment already documents as a known issue out of scope for
    // this suite to fix or assert against.
    expect(errors.some((message) => message.includes("sorenessMap"))).toBe(false);
  });

  test("clicking a body part visibly selects it (fill changes), with no console error", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await openWarRoom(page);

    const shoulder = page.locator("#LeftShoulder");
    await expect(shoulder).toHaveCSS("fill", UNSELECTED_FILL);

    await shoulder.click();

    await expect(shoulder).toHaveCSS("fill", "rgb(50, 205, 50)"); // limegreen, level 1
    // Scoped to the regression this file exists to catch — not a general
    // zero-console-errors assertion. The page has a separate, pre-existing,
    // unrelated bug (updateProfileAccountSection is not defined, fired on
    // every page load regardless of War Room) that shell.spec.js's own
    // header comment already documents as a known issue out of scope for
    // this suite to fix or assert against.
    expect(errors.some((message) => message.includes("sorenessMap"))).toBe(false);
  });

  test("clicking cycles through all four soreness levels and back to unselected", async ({ page }) => {
    await openWarRoom(page);
    const shoulder = page.locator("#LeftShoulder");

    await shoulder.click();
    await expect(shoulder).toHaveCSS("fill", "rgb(50, 205, 50)"); // level 1 — limegreen

    await shoulder.click();
    await expect(shoulder).toHaveCSS("fill", "rgb(255, 165, 0)"); // level 2 — orange

    await shoulder.click();
    await expect(shoulder).toHaveCSS("fill", "rgb(255, 0, 0)"); // level 3 — red

    await shoulder.click();
    await expect(shoulder).toHaveCSS("fill", UNSELECTED_FILL); // back to 0 — unselected
  });

  test("multiple body parts can be selected independently", async ({ page }) => {
    await openWarRoom(page);

    const shoulder = page.locator("#LeftShoulder");
    const chest = page.locator("#RightChest");

    await shoulder.click();
    await chest.click();
    await chest.click(); // chest to level 2 — orange

    await expect(shoulder).toHaveCSS("fill", "rgb(50, 205, 50)"); // unaffected by chest's clicks
    await expect(chest).toHaveCSS("fill", "rgb(255, 165, 0)");
  });

  test("the Reset button clears every selected body part back to unselected", async ({ page }) => {
    await openWarRoom(page);

    const shoulder = page.locator("#LeftShoulder");
    const chest = page.locator("#RightChest");
    await shoulder.click();
    await chest.click();

    await page.locator('button[onclick="resetSorenessMap()"]').click();

    await expect(shoulder).toHaveCSS("fill", UNSELECTED_FILL);
    await expect(chest).toHaveCSS("fill", UNSELECTED_FILL);
  });
});

test.describe("War Room — plan generation", () => {
  test("Generate War Room Plan produces a rendered report with no error alert", async ({ page }) => {
    let alertMessage = null;
    page.on("dialog", async (dialog) => {
      alertMessage = dialog.message();
      await dialog.dismiss();
    });

    await openWarRoom(page);
    await page.locator('button[onclick="generateWarRoomPlan()"]').click();

    await expect(page.locator("#dashboardOutput")).toContainText("WAR ROOM REPORT");
    await expect(page.locator("#dashboardOutput")).toContainText("Meet Readiness Score");
    expect(alertMessage).toBeNull();
    // a failure is now shown in the output itself rather than as an alert
    await expect(page.locator("#dashboardOutput .tool-message[data-kind='error']")).toHaveCount(0);
  });

  test("a generation failure is shown in the output, not as a browser alert", async ({ page }) => {
    let alertMessage = null;
    page.on("dialog", async (dialog) => {
      alertMessage = dialog.message();
      await dialog.dismiss();
    });

    await openWarRoom(page);
    // force the generator to fail part-way: reading the soreness map throws
    await page.evaluate(() => {
      sorenessMap = new Proxy({}, { ownKeys() { throw new Error("test: broken soreness map"); } });
    });
    await page.locator('button[onclick="generateWarRoomPlan()"]').click();

    const error = page.locator("#dashboardOutput .tool-message[data-kind='error']");
    await expect(error).toHaveText("War Room generation failed. Please try again.");
    await expect(error).toHaveAttribute("role", "alert");
    expect(alertMessage).toBeNull();
  });

  test("a selected body part's soreness reaches the generator and appears in the rendered plan", async ({ page }) => {
    await openWarRoom(page);

    await page.locator("#LeftShoulder").click(); // Shoulders -> level 1

    await page.locator('button[onclick="generateWarRoomPlan()"]').click();

    const output = page.locator("#dashboardOutput");
    await expect(output).toContainText("Targeted Soreness Recovery");
    await expect(output).toContainText("Rotator cuff"); // Shoulders-specific recovery text
  });

  test("with no soreness selected, the plan explicitly says so rather than fabricating recovery items", async ({ page }) => {
    await openWarRoom(page);

    await page.locator('button[onclick="generateWarRoomPlan()"]').click();

    await expect(page.locator("#dashboardOutput")).toContainText("No major soreness detected");
  });

  test("generating a plan twice in a row (re-selection between runs) does not throw and updates the output", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));

    await openWarRoom(page);

    await page.locator('button[onclick="generateWarRoomPlan()"]').click();
    await expect(page.locator("#dashboardOutput")).toContainText("No major soreness detected");

    await page.locator("#RightChest").click();
    await page.locator('button[onclick="generateWarRoomPlan()"]').click();

    await expect(page.locator("#dashboardOutput")).toContainText("Pec mobility");
    // Scoped to the regression this file exists to catch — not a general
    // zero-console-errors assertion. The page has a separate, pre-existing,
    // unrelated bug (updateProfileAccountSection is not defined, fired on
    // every page load regardless of War Room) that shell.spec.js's own
    // header comment already documents as a known issue out of scope for
    // this suite to fix or assert against.
    expect(errors.some((message) => message.includes("sorenessMap"))).toBe(false);
  });
});
