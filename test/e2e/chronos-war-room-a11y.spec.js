// Chronos and War Room accessibility: status that says what to do next and
// is announced, technical readings tucked away, clearly separate manual split
// timing whose controls work the video, a keyboard-usable soreness body map with useful names, and a
// War Room plan that is announced and focused when it's ready. Each test
// checks what a swimmer sees, or what a screen reader is given.

import { test, expect } from "@playwright/test";

async function open(page, id) {
  await page.goto("/");
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
  // the consent notice sits over the bottom of the page until answered
  await page.locator("#consentBanner").getByRole("button", { name: "Decline" }).click();
  await page.evaluate((p) => window.showPage(p), id);
  await expect(page.locator(`#${id}`)).toBeVisible();
}

test.describe("Chronos", () => {
  test("the status lines are announced, and say what to do next as the race is set up", async ({ page }) => {
    await open(page, "race");
    const status = page.locator("#racePipelineStatus");
    const calibration = page.locator("#raceCalibrationStatus");
    for (const region of [status, calibration]) {
      await expect(region).toHaveAttribute("role", "status");
      await expect(region).toHaveAttribute("aria-live", "polite");
    }
    await expect(status).toHaveText("Next: choose the event, the course and the pool length, then upload a race video.");
    await expect(calibration).toHaveText("Start and lane not marked yet.");

    // count what is written to the live region: an unchanged status is not re-announced
    await page.evaluate(() => {
      window.__statusWrites = 0;
      new MutationObserver(() => { window.__statusWrites += 1; })
        .observe(document.getElementById("racePipelineStatus"), { childList: true, characterData: true, subtree: true });
    });
    await page.locator("#raceEventSelect").selectOption("Freestyle 100m");
    await expect(status).toHaveText("Next: choose the course and the pool length, then upload a race video.");
    await page.locator("#raceEventSelect").selectOption("Freestyle 200m");        // same next step
    await expect(status).toHaveText("Next: choose the course and the pool length, then upload a race video.");
    expect(await page.evaluate(() => window.__statusWrites)).toBe(1);

    // choosing a course still selects the usual pool length (unchanged behaviour)
    await page.locator("#raceCourseSelect").selectOption("Long Course");
    await expect(page.locator("#racePoolLengthSelect")).toHaveValue("50");
    await expect(status).toHaveText("Next: upload a race video.");

    // the buttons say what's missing rather than failing silently
    await page.locator("#raceAutoStartBtn").click();
    await expect(status).toHaveText("Upload a race video first (step 2).");
    await page.locator("#raceCalibrateBtn").click();
    await expect(calibration).toHaveText("Upload a race video first (step 2), then mark the start and lane.");
  });

  test("course and pool length are explained, and the pool length is never filled in on its own", async ({ page }) => {
    await open(page, "race");
    const hint = page.locator("#raceCourseHint");
    await expect(hint).toHaveText("Short course is a 25 m pool and long course is a 50 m pool. Choosing a course selects that pool length below; change it if your pool is different.");
    await expect(page.locator("#raceCourseSelect")).toHaveAttribute("aria-describedby", "raceCourseHint");
    await expect(page.locator("#racePoolLengthSelect")).toHaveAttribute("aria-describedby", "raceCourseHint");
    // nothing is preselected before the swimmer chooses a course
    await expect(page.locator("#racePoolLengthSelect")).toHaveValue("");
    // a pool length the swimmer picks is kept when the course changes
    await page.locator("#racePoolLengthSelect").selectOption("25");
    await page.locator("#raceCourseSelect").selectOption("Long Course");
    await expect(page.locator("#racePoolLengthSelect")).toHaveValue("25");
  });

  test("step 3 is short and ordered", async ({ page }) => {
    await open(page, "race");
    await expect(page.locator("#raceCalibrateBtn").locator("xpath=preceding-sibling::p[1]")).toHaveText(
      "Pause the video just before the start, while the swimmer is still. Choose Mark Pre-Start Frame & Lane Position, then click the swimmer. Movement before this frame is ignored.");
  });

  test("the diagnostics are inside a collapsed Technical details section", async ({ page }) => {
    await open(page, "race");
    const details = page.locator("#race details.race-tech-details");
    await expect(details).toHaveCount(1);
    await expect(details).not.toHaveAttribute("open", "");
    await expect(details.locator("summary")).toHaveText("Technical details");
    await expect(details.locator("#racePipelineDiagnostics")).toHaveCount(1);
    await expect(page.locator("#racePipelineDiagnostics")).toBeHidden();
    await expect(page.locator("#race")).not.toContainText("Developer Diagnostics");
    // the turn-detection message stays in the technical readings, not the status line
    await expect(page.locator("#racePipelineStatus")).not.toContainText("reference lane Y");

    await details.locator("summary").click();
    await expect(page.locator("#racePipelineDiagnostics")).toBeVisible();
    await expect(page.locator("#racePipelineDiagnostics")).toContainText("Lifecycle: idle");
    await expect(page.locator("#racePipelineDiagnostics")).toContainText("Turn detection unavailable: reference lane Y not configured.");
  });

  test("manual split timing is a separate, named section with its own button names", async ({ page }) => {
    await open(page, "race");
    const auto = page.locator("#race .st-section").filter({ has: page.locator("#raceAutoStartBtn") });
    await expect(auto.locator(".st-section-title")).toHaveText("4. Run Automatic Analysis");

    const manual = page.getByRole("region", { name: "Manual Split Timing (optional)" });
    await expect(manual).toBeVisible();
    await expect(manual).toContainText("This is separate from the automatic analysis and doesn't change its results.");
    await expect(manual).toContainText("Play, Pause and Reset control the video; each split is the video's current time.");
    await expect(manual.getByRole("button")).toHaveText(["▶ Play Video", "⏸ Pause Video", "📍 Record Split", "🔁 Reset Video & Splits"]);
    await expect(manual.locator("#raceAutoStartBtn, #raceAutoStopBtn")).toHaveCount(0);
    await expect(manual.getByRole("heading", { name: "Manual Splits" })).toBeVisible();
    await expect(page.getByText(/stopwatch/i)).toHaveCount(0);
    // only automatic analysis is "Start"
    await expect(page.getByRole("button", { name: /^▶ Start/ })).toHaveText(["▶ Start Automatic Analysis"]);
  });

  test("Play Video plays the race video; Pause, Record Split and Reset work on it without starting the analysis", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await open(page, "race");
    const manual = page.getByRole("region", { name: "Manual Split Timing (optional)" });
    const video = page.locator("#racePlayer");
    const timer = page.locator("#timer");

    // no video yet: Play does nothing, and nothing breaks
    await manual.getByRole("button", { name: "▶ Play Video" }).click();
    await expect(timer).toHaveText("0.00 s");

    const webm = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 160; canvas.height = 90;
      const g = canvas.getContext("2d");
      const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm;codecs=vp8" });
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      let n = 0;
      const tick = setInterval(() => { g.fillStyle = `hsl(${(n++ * 9) % 360},60%,40%)`; g.fillRect(0, 0, 160, 90); }, 33);
      recorder.start();
      await new Promise((r) => setTimeout(r, 3000));
      clearInterval(tick); recorder.stop(); await stopped;
      const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    await page.setInputFiles("#raceVideo", { name: "clip.webm", mimeType: "video/webm", buffer: Buffer.from(webm, "base64") });
    await page.waitForFunction(() => document.getElementById("racePlayer").readyState >= 2);
    const statusBefore = await page.locator("#racePipelineStatus").innerText();
    expect(await video.evaluate((v) => v.paused)).toBe(true);

    await manual.getByRole("button", { name: "▶ Play Video" }).click();
    await expect.poll(() => video.evaluate((v) => !v.paused && v.currentTime > 0.3)).toBe(true);
    await expect(timer).not.toHaveText("0.00 s");                   // the shown time follows the video
    await expect(page.locator("#racePipelineStatus")).toHaveText(statusBefore); // automatic analysis not started

    await manual.getByRole("button", { name: "⏸ Pause Video" }).click();
    expect(await video.evaluate((v) => v.paused)).toBe(true);
    const at = await video.evaluate((v) => v.currentTime.toFixed(2));
    // the shown time stops on the last displayed frame (Pause is unchanged), within a frame or two of the video
    expect(Math.abs(parseFloat(await timer.innerText()) - Number(at))).toBeLessThan(0.1);

    await manual.getByRole("button", { name: "📍 Record Split" }).click();
    await expect(page.locator("#splits > div")).toHaveText([`${at} s`]);   // the video's current time

    // a second Play resumes from where it paused, with one display loop
    await manual.getByRole("button", { name: "▶ Play Video" }).click();
    await manual.getByRole("button", { name: "▶ Play Video" }).click();
    await expect.poll(() => video.evaluate((v, t) => !v.paused && v.currentTime > Number(t), at)).toBe(true);

    await manual.getByRole("button", { name: "🔁 Reset Video & Splits" }).click();
    expect(await video.evaluate((v) => v.paused && v.currentTime === 0)).toBe(true);
    await expect(timer).toHaveText("0.00 s");
    await expect(page.locator("#splits > div")).toHaveCount(0);
    await expect(page.locator("#racePipelineStatus")).toHaveText(statusBefore);
    expect(errors).toEqual([]);
  });
});

test.describe("War Room body map", () => {
  test("explains how to mark and raise soreness and what Reset does", async ({ page }) => {
    await open(page, "dashboard");
    await expect(page.locator("#bodyMapHint")).toHaveText(
      "Tap an area to mark soreness, and tap it again to raise the level: light, then moderate, then high, then back to none. Front and Back switch the view; Reset clears every area. With a keyboard, Tab to an area and press Enter or Space.");
    await expect(page.getByRole("group", { name: "Soreness body map, front" })).toBeVisible();
    await expect(page.getByRole("group", { name: "Soreness Body Map", exact: true }).getByRole("button")).toHaveText(["Front", "Back", "Reset"]);
  });

  test("every area is a named button that a keyboard can reach and change", async ({ page }) => {
    await open(page, "dashboard");
    const regions = page.locator(".body-part");
    await expect(regions).toHaveCount(44);
    const names = await regions.evaluateAll((els) => els.map((el) => ({
      role: el.getAttribute("role"), tabindex: el.getAttribute("tabindex"), name: el.getAttribute("aria-label") })));
    for (const r of names) {
      expect(r.role).toBe("button");
      expect(r.tabindex).toBe("0");
      expect(r.name).toMatch(/^((Left|Right) )?[A-Za-z ()]+: no soreness$/);
    }
    expect(new Set(names.map((r) => r.name)).size).toBeGreaterThan(30);

    // Tab from Reset lands on the first area; Enter and Space cycle it like a click
    await page.locator("button[onclick='resetSorenessMap()']").focus();
    await page.keyboard.press("Tab");
    const shoulder = page.locator("#LeftShoulder");
    await expect(shoulder).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(shoulder).toHaveAttribute("aria-label", "Left shoulder: light soreness");
    await expect(page.locator("#bodyMapStatus")).toHaveText("Left shoulder: light soreness.");
    await page.keyboard.press("Space");
    await expect(shoulder).toHaveAttribute("aria-label", "Left shoulder: moderate soreness");
    await page.keyboard.press("Enter");
    await expect(shoulder).toHaveAttribute("aria-label", "Left shoulder: high soreness");
    await expect(shoulder).toHaveCSS("fill", "rgb(255, 0, 0)");
    expect(await page.evaluate(() => sorenessMap.Shoulders)).toBe(3);
    await page.keyboard.press("Enter");
    await expect(shoulder).toHaveAttribute("aria-label", "Left shoulder: no soreness");

    // Reset puts every name back, and says so
    await page.keyboard.press("Enter");
    await page.locator("button[onclick='resetSorenessMap()']").click();
    await expect(shoulder).toHaveAttribute("aria-label", "Left shoulder: no soreness");
    await expect(page.locator("#bodyMapStatus")).toHaveText("Every area reset to no soreness.");
  });

  test("Front and Back say which view is showing, and the back areas can be reached", async ({ page }) => {
    await open(page, "dashboard");
    const front = page.getByRole("button", { name: "Front", exact: true });
    const back = page.getByRole("button", { name: "Back", exact: true });
    await expect(front).toHaveAttribute("aria-pressed", "true");
    await expect(back).toHaveAttribute("aria-pressed", "false");
    await back.click();
    await expect(front).toHaveAttribute("aria-pressed", "false");
    await expect(back).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("group", { name: "Soreness body map, back" })).toBeVisible();
    await page.locator("button[onclick='resetSorenessMap()']").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator("#bodyBack .body-part").first()).toBeFocused();
  });

  test("left and right are the swimmer's own sides, in both views", async ({ page }) => {
    await open(page, "dashboard");
    for (const view of ["front", "back"]) {
      await page.evaluate((v) => showBodyView(v), view);
      const sides = await page.locator(`#body${view === "front" ? "Front" : "Back"} .body-part`).evaluateAll((els) => {
        const centre = (el) => { const b = el.getBBox(); return b.x + b.width / 2; };
        const mid = els.map(centre).reduce((a, b) => a + b, 0) / els.length;
        return els.filter((el) => /^(Left|Right) /.test(el.getAttribute("aria-label")))
          .map((el) => ({ name: el.getAttribute("aria-label"), onViewersRight: centre(el) > mid }));
      });
      expect(sides.length).toBeGreaterThan(15);
      for (const s of sides) {
        // facing us, the swimmer's left is on our right; from behind, on our left
        const swimmersLeft = view === "front" ? s.onViewersRight : !s.onViewersRight;
        expect(s.name.startsWith(swimmersLeft ? "Left " : "Right "), `${view}: ${s.name}`).toBe(true);
      }
    }
  });

  test("an area marked from the keyboard reaches the plan exactly as a click does", async ({ page }) => {
    await open(page, "dashboard");
    await page.locator("#meetDays").fill("18");
    await page.locator("#RightChest").focus();
    await page.keyboard.press("Enter");
    await page.locator("button[onclick='generateWarRoomPlan()']").click();
    await expect(page.locator("#dashboardOutput")).toContainText("Pec mobility");
  });
});

test.describe("War Room plan", () => {
  test("is announced and receives focus when it's ready, each time it's generated", async ({ page }) => {
    await open(page, "dashboard");
    const announce = page.locator("#warRoomPlanStatus");
    await expect(announce).toHaveAttribute("role", "status");
    await expect(announce).toBeEmpty();

    await page.locator("#meetDays").fill("18");
    await page.locator("button[onclick='generateWarRoomPlan()']").click();
    const title = page.locator("#warRoomReportTitle");
    await expect(title).toBeFocused();
    await expect(title).toHaveText("🏊 WAR ROOM REPORT");
    await expect(announce).toHaveText("Your War Room plan is ready.");
    await expect(title).toBeInViewport();

    // a second plan is announced again (the message is cleared, then set)
    await page.evaluate(() => {
      window.__announcements = [];
      new MutationObserver(() => window.__announcements.push(document.getElementById("warRoomPlanStatus").textContent))
        .observe(document.getElementById("warRoomPlanStatus"), { childList: true, characterData: true, subtree: true });
    });
    await page.locator("#fatigue").selectOption("3");
    await page.locator("button[onclick='generateWarRoomPlan()']").click();
    await expect(page.locator("#warRoomReportTitle")).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.__announcements)).toEqual(["", "Your War Room plan is ready."]);
  });

  test("a missing days value still shows its error and does not move focus to a plan", async ({ page }) => {
    await open(page, "dashboard");
    await page.locator("button[onclick='generateWarRoomPlan()']").click();
    await expect(page.locator("#meetDaysError")).toBeVisible();
    await expect(page.locator("#warRoomReportTitle")).toHaveCount(0);
    await expect(page.locator("#warRoomPlanStatus")).toBeEmpty();
  });
});
