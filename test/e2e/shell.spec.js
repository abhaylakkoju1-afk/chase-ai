// Shell smoke tests for the existing Chase AI / Swimtics app shell.
//
// Scope, deliberately: only behaviors confirmed to currently work
// correctly (see the shell smoke-test feasibility assessment). This
// suite does not fix, work around, or add coverage for the known
// existing bugs (saveProfile(), updateProfileAccountSection(),
// logoutUser() are undefined; theme preference does not survive a
// reload because loadProfile() throws before the restore code runs).
//
// Every test uses Playwright's default per-test browser context, so
// localStorage never leaks between tests.

import { test, expect } from "@playwright/test";

/**
 * The cinematic entry gate covers the entire viewport (position: fixed,
 * inset: 0, z-index: 10000) and blocks all pointer events until
 * dismissed. Its CSS has a 1.1s transition on `visibility`, so it does
 * not actually stop intercepting clicks until that transition
 * completes. Every other shell interaction depends on this being done
 * first.
 */
async function dismissEntryGate(page) {
  const entryGate = page.locator("#entryGate");
  await page.locator("#enterButton").click();
  await entryGate.waitFor({ state: "hidden" });
}

test.describe("Entry gate", () => {
  test("clicking Enter dismisses the gate and unblocks the shell", async ({ page }) => {
    await page.goto("/");

    const entryGate = page.locator("#entryGate");
    await expect(entryGate).toBeVisible();

    await dismissEntryGate(page);

    await expect(entryGate).toBeHidden();
    const overflowY = await page.evaluate(() => document.body.style.overflowY);
    expect(overflowY).toBe("auto");
  });
});

test.describe("Navigation", () => {
  const destinations = [
    { id: "analyzer", label: "Chase AI" },
    { id: "pb", label: "Wall of Records" },
    { id: "race", label: "Chronos Engine" },
    { id: "profile", label: "Profile" },
    { id: "dashboard", label: "War Room" },
    { id: "home", label: "Home" },
  ];

  for (const { id, label } of destinations) {
    test(`clicking "${label}" shows #${id} and hides the other pages`, async ({ page }) => {
      await page.goto("/");
      await dismissEntryGate(page);

      await page.locator(`button[onclick="showPage('${id}')"]`).click();

      await expect(page.locator(`#${id}`)).toBeVisible();

      const otherIds = ["home", "analyzer", "pb", "race", "profile", "dashboard"].filter(
        (other) => other !== id
      );
      for (const other of otherIds) {
        await expect(page.locator(`#${other}`)).toBeHidden();
      }

      const homeFeatures = page.locator("#homeFeatures");
      if (id === "home") {
        await expect(homeFeatures).toBeVisible();
      } else {
        await expect(homeFeatures).toBeHidden();
      }
    });
  }
});

test.describe("PB tracker", () => {
  test("adding a PB shows it in the list and persists it to localStorage", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await page.locator("button[onclick=\"showPage('pb')\"]").click();

    await page.locator("#event").selectOption("Freestyle 50m");
    await page.locator("#course").selectOption("Short Course");
    await page.locator("#time").fill("28.50");
    await page.locator('button[onclick="savePB()"]').click();

    const items = page.locator("#pbList .pb-item");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("Freestyle 50m");
    await expect(items.first()).toContainText("Short Course");
    await expect(items.first()).toContainText("28.50");

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pbs")));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      event: "Freestyle 50m",
      course: "Short Course",
      time: "28.50",
    });
  });

  test("deleting a PB removes it from the list and from localStorage", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "pbs",
        JSON.stringify([
          { event: "Freestyle 50m", course: "Short Course", time: "28.50", history: [28.5] },
        ])
      );
    });

    await page.goto("/");
    await dismissEntryGate(page);
    await page.locator("button[onclick=\"showPage('pb')\"]").click();

    const items = page.locator("#pbList .pb-item");
    await expect(items).toHaveCount(1);

    await page.locator('button[onclick="deletePB(0)"]').click();

    await expect(items).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pbs")));
    expect(stored).toHaveLength(0);
  });
});

test.describe("Profile", () => {
  test("a previously saved profile is displayed on load", async ({ page }) => {
    const seededProfile = {
      name: "Test Swimmer",
      primaryStroke: "Freestyle",
      level: "Competitive",
      height: "180",
      weight: "75",
      shortGoal: "Break 25s",
    };

    await page.addInitScript((profile) => {
      localStorage.setItem("profile", JSON.stringify(profile));
    }, seededProfile);

    await page.goto("/");
    await dismissEntryGate(page);
    await page.locator("button[onclick=\"showPage('profile')\"]").click();

    await expect(page.locator("#name")).toHaveValue(seededProfile.name);

    await expect(page.locator("#displayName")).toHaveText(seededProfile.name);
    await expect(page.locator("#displayStroke")).toHaveText(seededProfile.primaryStroke);
    await expect(page.locator("#displayLevel")).toHaveText(seededProfile.level);
    await expect(page.locator("#displayHeight")).toHaveText(seededProfile.height);
    await expect(page.locator("#displayWeight")).toHaveText(seededProfile.weight);
    await expect(page.locator("#displayGoal")).toHaveText(seededProfile.shortGoal);
  });
});

test.describe("Theme toggle", () => {
  test("clicking the toggle immediately applies light mode", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const body = page.locator("body");
    await expect(body).not.toHaveClass(/light-mode/);

    await page.locator("#themeToggle").click();

    await expect(body).toHaveClass(/light-mode/);
    await expect(page.locator("#themeToggle")).toHaveText("🌙 Dark Mode");

    const storedTheme = await page.evaluate(() => localStorage.getItem("theme"));
    expect(storedTheme).toBe("light");
  });
});
