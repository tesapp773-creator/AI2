// netlify/functions/_browser.js
//
// Headless browser automation for MKDAI — lets it navigate real websites,
// click, fill forms, read pages, and take screenshots, like a human would.
// Uses puppeteer-core + @sparticuz/chromium, the standard combo for running
// a real Chromium browser inside a serverless function. This is a heavier,
// more fragile feature than the rest of MKDAI's tools (a real browser
// process, not just an API call) — worth knowing if it needs debugging on
// first real use.

async function launchBrowser() {
  const chromiumModule = require("@sparticuz/chromium");
  // This package ships as an ESM module wrapped for CJS — the actual
  // chromium object (with .args, .executablePath(), etc.) is on .default.
  const chromium = chromiumModule.default || chromiumModule;
  const puppeteer = require("puppeteer-core");
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 900 },
    executablePath,
    headless: true,
  });
  const page = await browser.newPage();
  return { browser, page };
}

// Tags every clickable/fillable element on the page with a stable
// data-mkdai-id attribute, and returns a summary listing them by ID — the
// agent acts on elements by ID (e.g. "click element 4") instead of guessing
// CSS selectors, which is far more reliable for an LLM to use correctly.
async function summarizePage(page) {
  return page.evaluate(() => {
    const interactive = Array.from(
      document.querySelectorAll("a, button, input, textarea, select, [role='button']")
    );
    const elements = interactive.slice(0, 60).map((el, i) => {
      el.setAttribute("data-mkdai-id", String(i));
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      const text = (
        el.innerText ||
        el.value ||
        el.getAttribute("placeholder") ||
        el.getAttribute("aria-label") ||
        ""
      ).trim().slice(0, 80);
      return { id: i, tag, type, text };
    });
    return { title: document.title, url: window.location.href, elements };
  });
}

async function navigate(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  return summarizePage(page);
}

async function clickElement(page, elementId) {
  const selector = `[data-mkdai-id="${elementId}"]`;
  const exists = await page.$(selector);
  if (!exists) {
    throw new Error(`No element with id ${elementId} on the current page — read the page again to get current element IDs.`);
  }
  await Promise.all([
    page.click(selector),
    page.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {}),
  ]);
  return summarizePage(page);
}

async function fillField(page, elementId, text) {
  const selector = `[data-mkdai-id="${elementId}"]`;
  const exists = await page.$(selector);
  if (!exists) {
    throw new Error(`No element with id ${elementId} on the current page — read the page again to get current element IDs.`);
  }
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.value = "";
  }, selector);
  await page.type(selector, text, { delay: 10 });
  return { filled: true, elementId };
}

async function readPage(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return { text: text.slice(0, 8000) };
}

async function takeScreenshot(page, supabase) {
  const buffer = await page.screenshot({ type: "png" });
  const fileName = `screenshots/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const { error } = await supabase.storage
    .from("mkdai-screenshots")
    .upload(fileName, buffer, { contentType: "image/png" });
  if (error) throw new Error(`Could not save screenshot: ${error.message}`);
  const { data } = supabase.storage.from("mkdai-screenshots").getPublicUrl(fileName);
  return { screenshotUrl: data.publicUrl };
}

async function closeBrowser(browser) {
  if (browser) await browser.close().catch(() => {});
}

module.exports = { launchBrowser, navigate, clickElement, fillField, readPage, takeScreenshot, closeBrowser };
