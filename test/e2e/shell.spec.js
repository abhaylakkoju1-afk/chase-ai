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
    { id: "analyzer", label: "Chase" },
    { id: "pb", label: "Wall of Records" },
    { id: "race", label: "Chronos" },
    { id: "dashboard", label: "War Room" },
    { id: "profile", label: "Profile" },
    { id: "home", label: "SWIMTICS (Home)" },
  ];

  for (const { id, label } of destinations) {
    test(`clicking "${label}" shows #${id} and hides the other pages`, async ({ page }) => {
      await page.goto("/");
      await dismissEntryGate(page);

      await navigateTo(page, id);

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

test.describe("Site nav Tools menu", () => {
  test("lists the five tools in order and is collapsed by default", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const toggle = page.locator("#siteNavToolsButton");
    const menu = page.locator("#siteNavToolsMenu");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(menu.locator("button")).toHaveText([
      "Chase", "Wall of Records", "Chronos", "War Room", "Profile",
    ]);
  });

  test("closes on Escape (returning focus), on outside click and after choosing a page", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    const toggle = page.locator("#siteNavToolsButton");
    const menu = page.locator("#siteNavToolsMenu");

    await toggle.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await expect(menu.locator("button").first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.locator("#home").click({ position: { x: 20, y: 300 } });
    await expect(menu).toBeHidden();

    await navigateTo(page, "race");
    await expect(menu).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#race")).toBeVisible();
  });

  test("Sign In opens the Profile page (no authentication yet)", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);

    await page.locator(".site-nav-signin").click();
    await expect(page.locator("#profile")).toBeVisible();
    await expect(page.locator("#home")).toBeHidden();
  });
});

test.describe("PB tracker", () => {
  test("adding a PB shows it in the list and persists it to localStorage", async ({ page }) => {
    await page.goto("/");
    await dismissEntryGate(page);
    await navigateTo(page, "pb");

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
    await navigateTo(page, "pb");

    const items = page.locator("#pbList .pb-item");
    await expect(items).toHaveCount(1);

    await page.locator('button[onclick="deletePB(0)"]').click();

    await expect(items).toHaveCount(0);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("pbs")));
    expect(stored).toHaveLength(0);
  });
});

test.describe("Profile", () => {
  test("without a configured database, accounts show as unavailable and Save Profile saves on this device", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await dismissEntryGate(page);
    await navigateTo(page, "profile");

    await expect(page.locator("#accountDetails")).toContainText("Accounts aren't available yet");
    await expect(page.locator(".login-btn")).toBeHidden();
    await expect(page.locator("button[onclick='logoutUser()']")).toBeHidden();

    await page.locator("#name").fill("Device Only");
    await page.locator("#club").fill("Local Club");
    await page.locator("button[onclick='saveProfile()']").click();
    await expect(page.locator("#profileSaveStatus")).toHaveText("Saved on this device.");
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("profile")));
    expect(stored.name).toBe("Device Only");
    expect(stored.club).toBe("Local Club");
    await expect(page.locator("#displayName")).toHaveText("Device Only");

    // the long-standing startup ReferenceError (updateProfileAccountSection) is gone
    expect(errors.filter((m) => /is not defined/.test(m))).toEqual([]);
  });

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
    await navigateTo(page, "profile");

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
