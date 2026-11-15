// Saved text is shown as text, never run as HTML.
//
// Personal bests and profile details are saved in localStorage and, with
// accounts on, synced from the account. Before this fix the Wall of Records
// list and the Profile stroke cards built their HTML from those saved values,
// so a time like `27<img src=x onerror=…>` or a club name with markup ran
// script on every visit. These tests save HTML-like values the way a swimmer
// would (or the way synced data would arrive), then check that the text is
// shown literally, that no element is created from it, and that no script or
// event handler runs, including after a reload.

import { test, expect } from "@playwright/test";

// Each payload records a hit in window.__xss if it ever runs.
const hit = (label) => `window.__xss.push('${label}')`;
const IMG = (label) => `<img src=x onerror="${hit(label)}">`;
const SVG = (label) => `<svg onload="${hit(label)}"></svg>`;

let dialogs = [];
test.beforeEach(async ({ page }) => {
  dialogs = [];
  await page.addInitScript(() => { window.__xss = []; });
  page.on("dialog", async (d) => { dialogs.push(d.message()); await d.dismiss(); });
});

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

// An injected <img src=x> fires onerror after its request fails. Waiting for
// a control image to the same missing path to fail gives any injected one
// the same chance to run before we check that nothing did.
async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const img = new Image();
    img.onload = img.onerror = () => setTimeout(resolve, 100);
    img.src = "/x?control";
  }));
}

async function expectNothingRan(page) {
  await settle(page);
  expect(await page.evaluate(() => window.__xss)).toEqual([]);
  expect(dialogs).toEqual([]);
}

// No element anywhere on the page carries the payloads' markers.
async function expectNoInjectedElements(page) {
  const found = await page.evaluate(() => ({
    onerror: document.querySelectorAll("[onerror]").length,
    onload: document.querySelectorAll("[onload]").length,
    marked: document.querySelectorAll("#injectedMarker, b.injected").length,
  }));
  expect(found).toEqual({ onerror: 0, onload: 0, marked: 0 });
}

test.describe("Wall of Records: saved PB text", () => {
  test("a time typed with HTML in it is shown literally, on the list and the stroke cards, and never runs", async ({ page }) => {
    const typed = `27${IMG("typed-time")}`;
    await open(page, "pb");
    await page.locator("#event").selectOption("Freestyle 50m");
    await page.locator("#time").fill(typed);
    await page.locator("button[onclick='savePB()']").click();

    // (this value is saved today because the time check is lenient; tightening
    //  it is a separate change, and the seeded-storage test below covers the
    //  same rendering without depending on the form)
    const item = page.locator("#pbList .pb-item");
    await expect(item).toHaveCount(1);
    await expect(item.locator(".pb-time")).toHaveText(typed);
    await expect(item.locator(".pb-time *")).toHaveCount(0);
    await expect(page.locator("#strokeCards .stroke-times").first()).toContainText(`50m: ${typed}`);
    await expectNoInjectedElements(page);
    await expectNothingRan(page);

    // it is stored as typed, and stays inert on the next visit
    expect(JSON.parse(await page.evaluate(() => localStorage.getItem("pbs")))[0].time).toBe(typed);
    await open(page, "pb");
    await expect(page.locator("#pbList .pb-time")).toHaveText(typed);
    await expect(page.locator("#strokeCards .stroke-times").first()).toContainText(`50m: ${typed}`);
    await expectNoInjectedElements(page);
    await expectNothingRan(page);
  });

  test("HTML-like event, course and time from storage (as synced data would arrive) are shown as text", async ({ page }) => {
    const pb = {
      event: `Freestyle 50m<b class="injected">x</b>`,
      course: `Long Course${SVG("course")}`,
      time: `24.85${IMG("stored-time")}`,
      history: [24.85],
    };
    await page.addInitScript((p) => {
      if (!localStorage.getItem("pbs")) localStorage.setItem("pbs", JSON.stringify([p]));
    }, pb);

    for (const visit of ["first visit", "after reload"]) {
      await open(page, "pb");
      const item = page.locator("#pbList .pb-item");
      await expect(item, visit).toHaveCount(1);
      await expect(item.locator(".pb-title"), visit).toHaveText(`${pb.event} (${pb.course}) - ${pb.time}`);
      await expect(item.locator(".pb-title > *"), visit).toHaveCount(1);   // only the time span
      await expect(item.locator(".chart-btn"), visit)
        .toHaveAttribute("aria-label", `Show or hide the chart for ${pb.event} (${pb.course})`);
      await expectNoInjectedElements(page);
      await expectNothingRan(page);
    }
  });

  test("ordinary PBs look and work as before: title, buttons, chart and delete", async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem("pbs")) localStorage.setItem("pbs", JSON.stringify([
        { event: "Freestyle 50m", course: "Long Course", time: "24.85", history: [25.1, 24.85] },
        { event: "Butterfly 200m", course: "Short Course", time: "2:05.33", history: [125.33] },
      ]));
    });
    await open(page, "pb");
    const items = page.locator("#pbList .pb-item");
    await expect(items).toHaveCount(2);
    await expect(items.nth(0).locator(".pb-title")).toHaveText("Freestyle 50m (Long Course) - 24.85");
    await expect(items.nth(1).locator(".pb-time")).toHaveText("2:05.33");
    await expect(items.nth(0).locator(".pb-controls button")).toHaveText(["Edit", "Delete", "📊"]);
    await expect(page.locator("#chart-container-0")).toBeHidden();
    await expect(page.locator("#chart-container-0 .chart-title")).toHaveText("Performance Trajectory");

    await page.locator("#pbList button[onclick='toggleChart(0)']").click();
    await expect(page.locator("#chart-container-0")).toBeVisible();
    await expect(page.locator("#chart-0")).toBeVisible();

    await page.locator("#pbList button[onclick='editPB(1)']").click();
    await expect(page.locator("#time")).toHaveValue("2:05.33");

    await page.locator("#pbList button[onclick='deletePB(0)']").click();
    await expect(items).toHaveCount(1);
    await expect(items.first().locator(".pb-title")).toHaveText("Butterfly 200m (Short Course) - 2:05.33");
  });
});

test.describe("Profile: saved text on the stroke cards", () => {
  test("Club, Nationality and Gender typed with HTML are shown literally and never run, including after reload", async ({ page }) => {
    const club = `Tigers${IMG("club")}`;
    const nationality = `<b class="injected" id="injectedMarker">NAT</b>`;
    const gender = `Other${SVG("gender")}`;

    await open(page, "profile");
    await page.locator("#club").fill(club);
    await page.locator("#nationality").fill(nationality);
    await page.locator("#gender").fill(gender);
    await page.locator("button[onclick='saveProfile()']").click();

    for (const visit of ["after save", "after reload"]) {
      if (visit === "after reload") await open(page, "profile");
      const cards = page.locator("#strokeCards .stroke-card");
      await expect(cards, visit).toHaveCount(4);
      const meta = cards.first().locator(".stroke-meta");
      await expect(meta, visit).toHaveText(`${nationality}${club}${gender}`, { useInnerText: false });
      await expect(meta.locator("*"), visit).toHaveCount(2);   // the two <br> separators only
      await expect(meta.locator("br"), visit).toHaveCount(2);
      await expect(page.locator("#club"), visit).toHaveValue(club);
      await expectNoInjectedElements(page);
      await expectNothingRan(page);
    }
  });

  test("saved photos that try to break out of the src attribute stay a plain src", async ({ page }) => {
    const photo = `x" onerror="${hit("profile-photo")}`;
    const cardPhoto = `y" onerror="${hit("card-photo")}`;
    await page.addInitScript(([p, c]) => {
      localStorage.setItem("profile", JSON.stringify({ name: "A", photo: p }));
      localStorage.setItem("strokeData", JSON.stringify({ freestyle: { photo: c } }));
    }, [photo, cardPhoto]);

    for (const visit of ["first visit", "after reload"]) {
      await open(page, "profile");
      const img = page.locator("#profileImageBox img");
      await expect(img, visit).toHaveCount(1);
      await expect(img, visit).toHaveAttribute("alt", "Profile");
      expect(await img.evaluate((el) => el.getAttribute("src")), visit).toBe(photo);
      // the freestyle card's background image keeps the saved value as its src
      expect(await page.locator("#strokeCards .card-bg-image img").first().evaluate((el) => el.getAttribute("src")), visit).toBe(cardPhoto);
      await expectNoInjectedElements(page);
      await expectNothingRan(page);
    }
  });

  test("ordinary profile values look as before, with & and quotes shown once", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("profile", JSON.stringify({ name: "Sam", club: `Tigers & Co. "Elite"`, nationality: "🇮🇳 India", gender: "female" }));
      localStorage.setItem("pbs", JSON.stringify([{ event: "Freestyle 50m", course: "Long Course", time: "24.85", history: [24.85] }]));
    });
    await open(page, "profile");
    const card = page.locator("#strokeCards .stroke-card").first();
    await expect(card.locator(".stroke-name")).toHaveText("FREESTYLE");
    await expect(card.locator(".stroke-meta")).toHaveText(`🇮🇳 India\nTigers & Co. "Elite"\n♀ Female`, { useInnerText: true });
    await expect(card.locator(".stroke-times")).toHaveText("50m: 24.85\n100m: --\n200m: --", { useInnerText: true });
    await expect(card.locator(".card-bg-image img")).toHaveCount(1);
    await expect(page.locator("#profileImageBox")).toHaveText("Upload Image");
  });

  // No PBs here: with a saved PB, a gender other than male/female stops the
  // cards rendering at all. That is an existing, separate bug (the score
  // lookup has no table for it), not part of this change.
  test("a custom gender with & is shown once, not as &amp; (it used to be escaped by hand)", async ({ page }) => {
    await open(page, "profile");
    await page.locator("#gender").fill("Non-binary & proud");
    await page.locator("button[onclick='saveProfile()']").click();
    const meta = page.locator("#strokeCards .stroke-card").first().locator(".stroke-meta");
    await expect(meta).toContainText("Non-binary & proud");
    await expect(meta).not.toContainText("&amp;");
  });
});
