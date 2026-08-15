#!/usr/bin/env node
// The showcase's guard against silently going blank.
//
// «Состояния и края» exists so nobody has to unplug a drive or evict a file to
// review those screens. Its failure mode is quiet: a boxed screen outgrows its
// frame, a component starts needing a live vault and throws, a label ends up
// the colour of what it sits on — and the page still looks fine at a glance
// while the states are no longer reviewable. This checks what a jsdom test
// cannot: real layout, real colours, real console.
// See DESIGN_SYSTEM.md, «Витрина состояний и краёв».

import { chromium } from "playwright";

const DEFAULT_AUDIT_URL = "http://127.0.0.1:1420/edge-states.html";
const AUDIT_URL = process.env.MINE_EDGE_STATES_AUDIT_URL ?? DEFAULT_AUDIT_URL;
const VIEWPORT = { width: 1440, height: 1000 };
/// The cloud badge is deliberately late (CLOUD_BADGE_DELAY_MS); wait past it.
const BADGE_WAIT_MS = 2200;

const failures = [];

function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function assertDevServerReady(url) {
  try {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(
      [
        `Edge-states route is not reachable: ${url}`,
        "Start the dev server first, then rerun this audit.",
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
      ].join("\n"),
    );
  }
}

async function main() {
  await assertDevServerReady(AUDIT_URL);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  try {
    await page.goto(AUDIT_URL, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-design-edge-states]", { timeout: 15_000 });
    await page.waitForTimeout(BADGE_WAIT_MS);

    const report = await page.evaluate(() => {
      const section = document.querySelector("[data-design-edge-states]");
      const out = {
        height: Math.round(section.getBoundingClientRect().height),
        badgeVisible: !!document.querySelector("[data-card-cloud-badge]"),
        clipperStatuses: document.querySelectorAll("[data-clipper-status]").length,
        disclaimers: document.querySelectorAll("[data-cloud-disclaimer]").length,
        spaceUnavailable: !!document.querySelector("[data-space-unavailable]"),
        folderConfirmation: !!document.querySelector("[data-folder-confirmation]"),
        onboarding: !!document.querySelector("[data-empty-space-onboarding]"),
        activityIndicators: document.querySelectorAll("[data-main-secondary-activity]").length,
        overflowX:
          document.documentElement.scrollWidth > document.documentElement.clientWidth,
        clipped: [],
        invisibleText: [],
        emptyCases: 0,
      };

      // A boxed screen taller than its frame is showing only part of itself.
      for (const frame of document.querySelectorAll("[data-design-edge-states] .h-96")) {
        const inner = frame.firstElementChild;
        if (!inner) continue;
        if (inner.scrollHeight > frame.clientHeight + 2) {
          out.clipped.push(`${inner.scrollHeight - frame.clientHeight}px`);
        }
      }

      // Text the same colour as whatever it sits on is text nobody can read.
      for (const el of section.querySelectorAll("p, span, h1, h2, button")) {
        if (!el.textContent.trim()) continue;
        const color = getComputedStyle(el).color;
        let background = "rgba(0, 0, 0, 0)";
        let node = el;
        while (node && background === "rgba(0, 0, 0, 0)") {
          background = getComputedStyle(node).backgroundColor;
          node = node.parentElement;
        }
        if (color === background) out.invisibleText.push(el.textContent.trim().slice(0, 40));
      }

      // A case that renders nothing is a state that quietly stopped existing.
      for (const el of section.querySelectorAll("[data-design-edge-states] > div > div")) {
        if (!el.textContent.trim()) out.emptyCases += 1;
      }
      return out;
    });

    check("section renders", report.height > 1000, `${report.height}px tall`);
    check("no case came out empty", report.emptyCases === 0, `${report.emptyCases} empty`);
    check(
      "the late cloud badge appears on its own",
      report.badgeVisible,
      `after ${BADGE_WAIT_MS}ms`,
    );
    check(
      "every clipper variant is drawn",
      report.clipperStatuses === 4,
      `${report.clipperStatuses} of 4`,
    );
    check(
      "the iCloud explanation is drawn both ways",
      report.disclaimers === 2,
      `${report.disclaimers} of 2`,
    );
    check("the unavailable-space screen is drawn", report.spaceUnavailable);
    check("the folder confirmation is drawn", report.folderConfirmation);
    check("the empty-space onboarding is drawn", report.onboarding);
    check(
      "all three indicator combinations are drawn",
      report.activityIndicators === 3,
      `${report.activityIndicators} of 3`,
    );
    check(
      "no boxed screen is cut off by its frame",
      report.clipped.length === 0,
      report.clipped.join(", ") || undefined,
    );
    check(
      "no text is the colour of its background",
      report.invisibleText.length === 0,
      report.invisibleText.join(" | ") || undefined,
    );
    check("the page does not scroll sideways", !report.overflowX);
    check(
      "nothing throws while drawing the states",
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | ") || undefined,
    );
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error(`\nEdge-states showcase checks failed: ${failures.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nAll edge-states showcase checks passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
