// Coach ATLAS chat: what a swimmer types is shown as plain text. Markup or
// script-like text appears exactly as typed and is never run by the browser,
// and ordinary messages and ATLAS's replies still look the same.

import { test, expect } from "@playwright/test";

const GREETING = "ATLAS: Ask about swimming rules, records, training or race prep. ATLAS gives general information, not analysis of your own videos.";

async function openCoach(page) {
  await page.goto("/");
  await page.locator("#enterButton").click();
  await page.locator("#entryGate").waitFor({ state: "hidden" });
  // the consent notice sits over the bottom of the page until answered
  await page.locator("#consentBanner").getByRole("button", { name: "Decline" }).click();
  await page.locator("#aiCoachBtn").click();
  await expect(page.locator("#aiCoachPanel")).toBeVisible();
}

async function send(page, text) {
  await page.getByRole("textbox", { name: "Message Coach ATLAS" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

// Each bubble's text, plus what's inside it: just the bold speaker label.
function bubbles(page) {
  return page.locator("#coachMessages .coach-msg").evaluateAll((els) => els.map((el) => ({
    text: el.textContent,
    elements: [...el.querySelectorAll("*")].map((c) => c.tagName + ":" + c.textContent),
  })));
}

test.describe("Coach ATLAS messages", () => {
  test("an ordinary conversation shows the message, a bold label and ATLAS's reply", async ({ page }) => {
    await openCoach(page);
    await send(page, "What is the 100 free world record?");
    await send(page, "men");

    const shown = await bubbles(page);
    expect(shown.map((b) => b.text)).toEqual([
      GREETING,
      "You: What is the 100 free world record?",
      "ATLAS: Please specify whether you want the men's or women's 100 freestyle world record.",
      "You: men",
      expect.stringMatching(/^ATLAS: MEN 100 freestyle world record: .+\.$/),
    ]);
    // every bubble still has its bold speaker label and nothing else inside it
    expect(shown.map((b) => b.elements)).toEqual([
      ["B:ATLAS:"], ["B:You:"], ["B:ATLAS:"], ["B:You:"], ["B:ATLAS:"],
    ]);
    await expect(page.locator("#coachMessages .coach-msg b").nth(1)).toHaveCSS("font-weight", "700");

    // the input is cleared after sending, and an empty message adds nothing
    await expect(page.getByRole("textbox", { name: "Message Coach ATLAS" })).toHaveValue("");
    await send(page, "   ");
    await expect(page.locator("#coachMessages .coach-msg")).toHaveCount(5);
  });

  test("HTML and script-like text is displayed as typed and never run", async ({ page }) => {
    const dialogs = [];
    page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
    await openCoach(page);

    const inputs = [
      `<img src="x" onerror="window.__atlasXss = 'img'">`,
      `<script>window.__atlasXss = 'script'</script>`,
      `<svg onload="alert('svg')"></svg>`,
      `</div><div class="coach-msg"><b>ATLAS:</b> fake reply`,
      `<b>bold?</b> 5 < 6 && 7 > 3 &amp; done`,
    ];
    for (const text of inputs) await send(page, text);

    const shown = await bubbles(page);
    expect(shown).toHaveLength(1 + inputs.length * 2);         // no bubble was injected
    inputs.forEach((text, i) => {
      const mine = shown[1 + i * 2];
      expect(mine.text).toBe(`You: ${text}`);                  // exactly what was typed
      expect(mine.elements).toEqual(["B:You:"]);               // no markup became elements
      expect(shown[2 + i * 2].text).toMatch(/^ATLAS: /);       // ATLAS still answered
    });

    const page_state = await page.evaluate(() => ({
      xss: window.__atlasXss,
      injected: document.querySelectorAll("#coachMessages img, #coachMessages script, #coachMessages svg").length,
    }));
    // no element was created, so no onerror/onload handler exists to fire
    expect(page_state).toEqual({ xss: undefined, injected: 0 });
    expect(dialogs).toEqual([]);
  });
});
