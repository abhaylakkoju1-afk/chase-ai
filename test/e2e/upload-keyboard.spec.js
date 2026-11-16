// Video uploads on Chase and Chronos are usable from the keyboard.
//
// Each upload is a real file input that is visually hidden (not
// display: none or the hidden attribute) with its styled label as the
// visible button. So Tab reaches it, a screen reader hears the label's
// name and the selected-file line, Enter or Space opens the file picker,
// and the label shows a focus ring. Clicking or tapping the label still
// opens the picker. Every test feeds the chosen file through the real
// picker (Playwright's file chooser) and checks the page's existing
// change handler received it: the file name is shown and the video
// player loads it.

import { test, expect } from "@playwright/test";

async function open(page, id) {
  // Playwright starts intercepting file pickers when the first
  // "filechooser" listener is added, asynchronously; a key press sent right
  // after adding one can beat it and the picker event is missed. Adding a
  // listener before the page loads makes interception ready in time.
  page.on("filechooser", () => {});
  await page.goto("/");
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
  // the consent notice sits over the bottom of the page until answered
  await page.locator("#consentBanner").getByRole("button", { name: "Decline" }).click();
  await page.evaluate((p) => window.showPage(p), id);
  await expect(page.locator(`#${id}`)).toBeVisible();
}

// A short real WebM made in the page, so the player can actually load it.
async function makeWebm(page) {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const g = canvas.getContext("2d");
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm;codecs=vp8" });
    const chunks = [];
    recorder.ondataavailable = (e) => chunks.push(e.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    let n = 0;
    const tick = setInterval(() => { g.fillStyle = `hsl(${(n++ * 40) % 360},60%,40%)`; g.fillRect(0, 0, 160, 90); }, 33);
    recorder.start();
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(tick); recorder.stop(); await stopped;
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(base64, "base64");
}

// Runs `open` (a key press, click or tap), and feeds the file to the picker it opens.
async function chooseThroughPicker(page, openPicker, file) {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 5000 }), openPicker()]);
  expect(chooser.isMultiple()).toBe(false);
  await chooser.setFiles(file);
}

const UPLOADS = [
  {
    page: "analyzer",
    title: "Chase",
    input: "#videoUpload",
    name: "Upload Swim Video",
    fileLine: "#fileName",
    player: "#analyzerPlayer",
    // the field just after the upload in the tab order
    next: "#stroke",
    received: async (page) => {
      await expect(page.locator("#chaseStatus")).toHaveText("● Video loaded. Choose a stroke, then press Analyze.");
    },
  },
  {
    page: "race",
    title: "Chronos",
    input: "#raceVideo",
    name: "Upload Race Video",
    fileLine: "#raceFileName",
    player: "#racePlayer",
    // the field just before the upload in the tab order
    previous: "#racePoolLengthSelect",
    received: async () => {},
  },
];

for (const u of UPLOADS) {
  test.describe(`${u.title} video upload`, () => {
    test("is a real, named file input in the accessibility tree, not hidden", async ({ page }) => {
      await open(page, u.page);
      const input = page.locator(u.input);
      await expect(input).not.toHaveAttribute("hidden", /.*/);
      expect(await input.evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
      expect(await input.evaluate((el) => getComputedStyle(el).visibility)).toBe("visible");
      await expect(input).toHaveAccessibleName(u.name);
      await expect(input).toHaveAccessibleDescription("No file selected");
      await expect(page.getByLabel(u.name)).toHaveAttribute("id", u.input.slice(1));

      // the visible button is still the label, looking as before
      const label = page.locator(`label[for="${u.input.slice(1)}"]`);
      await expect(label).toBeVisible();
      // the emoji, then the name, as before
      await expect(label).toHaveText(new RegExp(`^\\s*\\S+\\s+${u.name}\\s*$`));
      await expect(label.locator('span[aria-hidden="true"]')).toHaveCount(1);   // the emoji isn't read out
    });

    test("Tab reaches it, the label shows a focus ring, and Enter opens the picker; the file reaches the page", async ({ page }) => {
      await open(page, u.page);
      const input = page.locator(u.input);
      const label = page.locator(`label[for="${u.input.slice(1)}"]`);
      const file = { name: `keyboard-${u.page}.webm`, mimeType: "video/webm", buffer: await makeWebm(page) };

      await expect(label).toHaveCSS("outline-style", "none");
      if (u.previous) {
        await page.locator(u.previous).focus();
        await page.keyboard.press("Tab");
      } else {
        await page.locator(u.next).focus();
        await page.keyboard.press("Shift+Tab");
      }
      await expect(input).toBeFocused();
      await expect(label).toHaveCSS("outline-style", "solid");
      await expect(label).toHaveCSS("outline-width", "2px");

      await chooseThroughPicker(page, () => page.keyboard.press("Enter"), file);

      await expect(page.locator(u.fileLine)).toHaveText(file.name);
      await expect(input).toHaveAccessibleDescription(file.name);
      expect(await page.locator(u.player).evaluate((v) => v.src.startsWith("blob:"))).toBe(true);
      await page.waitForFunction((sel) => document.querySelector(sel).readyState >= 1, u.player);
      await u.received(page);

      // focus stays on the upload, so Tab carries on through the page
      await expect(input).toBeFocused();
      if (u.next) {
        await page.keyboard.press("Tab");
        await expect(page.locator(u.next)).toBeFocused();
      }
    });

    test("Space opens the picker too", async ({ page }) => {
      await open(page, u.page);
      const file = { name: `space-${u.page}.webm`, mimeType: "video/webm", buffer: await makeWebm(page) };
      await page.locator(u.previous || u.next).focus();
      await page.keyboard.press(u.previous ? "Tab" : "Shift+Tab");
      await expect(page.locator(u.input)).toBeFocused();

      await chooseThroughPicker(page, () => page.keyboard.press("Space"), file);
      await expect(page.locator(u.fileLine)).toHaveText(file.name);
      await page.waitForFunction((sel) => document.querySelector(sel).readyState >= 1, u.player);
      await u.received(page);
    });

    test("clicking the button still opens the picker, without a keyboard focus ring", async ({ page }) => {
      await open(page, u.page);
      const label = page.locator(`label[for="${u.input.slice(1)}"]`);
      const file = { name: `mouse-${u.page}.webm`, mimeType: "video/webm", buffer: await makeWebm(page) };

      await chooseThroughPicker(page, () => label.click(), file);
      await expect(page.locator(u.fileLine)).toHaveText(file.name);
      await page.waitForFunction((sel) => document.querySelector(sel).readyState >= 1, u.player);
      await u.received(page);
      await expect(label).toHaveCSS("outline-style", "none");
    });
  });

  test.describe(`${u.title} video upload on a touch screen`, () => {
    test.use({ hasTouch: true });

    test("tapping the button opens the picker", async ({ page }) => {
      await open(page, u.page);
      const file = { name: `touch-${u.page}.webm`, mimeType: "video/webm", buffer: await makeWebm(page) };
      await chooseThroughPicker(page, () => page.locator(`label[for="${u.input.slice(1)}"]`).tap(), file);
      await expect(page.locator(u.fileLine)).toHaveText(file.name);
      await page.waitForFunction((sel) => document.querySelector(sel).readyState >= 1, u.player);
    });
  });
}
