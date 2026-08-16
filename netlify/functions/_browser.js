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
  // @sparticuz/chromium ships as a pure ES Module — require() works in some
  // local Node setups but fails under Netlify's actual Lambda runtime with
  // "require() of ES Module not supported". Dynamic import() works for
  // both ESM and CJS packages, so it's the safe choice here regardless of
  // how either package is packaged.
  const chromiumModule = await import("@sparticuz/chromium");
  const chromium = chromiumModule.default || chromiumModule;
  const puppeteerModule = await import("puppeteer-core");
  const puppeteer = puppeteerModule.default || puppeteerModule;
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
    const elements = interactive.slice(0, 150).map((el, i) => {
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

// Upload a file into a <input type="file"> element on the page. The file
// itself has to come from somewhere real — either a URL to fetch first
// (sourceUrl) or literal text content to write out (fileContent, e.g. the
// text the user attached to this task). Exactly one of those must be given.
async function uploadFile(page, { elementId, sourceUrl, fileContent, fileName }) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const selector = `[data-mkdai-id="${elementId}"]`;
  const inputHandle = await page.$(selector);
  if (!inputHandle) {
    throw new Error(`No element with id ${elementId} on the current page — read the page again to get current element IDs.`);
  }

  const name = fileName || `mkdai-upload-${Date.now()}`;
  const tmpPath = path.join(os.tmpdir(), name);

  if (sourceUrl) {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`Could not download the source file (${res.status}) from ${sourceUrl}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);
  } else if (fileContent) {
    fs.writeFileSync(tmpPath, fileContent, "utf8");
  } else {
    throw new Error("uploadFile needs either sourceUrl (a link to the file) or fileContent (text to write as the file).");
  }

  await inputHandle.uploadFile(tmpPath);
  fs.unlinkSync(tmpPath);
  return { uploaded: true, elementId, fileName: name };
}

// Click something that triggers a file download (a download link/button),
// capture the resulting file via Chrome's download behavior, and store it
// in Supabase Storage so the user actually gets a URL to it — there's no
// other way to hand a downloaded file back to the user from here.
async function downloadFile(page, supabase, elementId) {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const selector = `[data-mkdai-id="${elementId}"]`;
  const exists = await page.$(selector);
  if (!exists) {
    throw new Error(`No element with id ${elementId} on the current page — read the page again to get current element IDs.`);
  }

  const downloadDir = path.join(os.tmpdir(), `mkdai-downloads-${Date.now()}`);
  fs.mkdirSync(downloadDir, { recursive: true });

  const client = await page.createCDPSession();
  await client.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

  await page.click(selector);

  // Poll for the download to appear and finish (Chrome writes a
  // .crdownload file while in progress, then renames it when done).
  const timeoutMs = 20000;
  const start = Date.now();
  let finishedFile = null;
  while (Date.now() - start < timeoutMs) {
    const files = fs.readdirSync(downloadDir);
    const done = files.find((f) => !f.endsWith(".crdownload"));
    if (done) {
      finishedFile = done;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!finishedFile) {
    throw new Error("No download finished within 20 seconds — the element may not actually trigger a download.");
  }

  const localPath = path.join(downloadDir, finishedFile);
  const buffer = fs.readFileSync(localPath);
  const storagePath = `downloads/${Date.now()}-${finishedFile}`;
  const { error } = await supabase.storage.from("mkdai-files").upload(storagePath, buffer);
  if (error) throw new Error(`Downloaded the file but could not save it: ${error.message}`);
  const { data } = supabase.storage.from("mkdai-files").getPublicUrl(storagePath);

  fs.rmSync(downloadDir, { recursive: true, force: true });
  return { downloaded: true, fileName: finishedFile, fileUrl: data.publicUrl };
}

async function closeBrowser(browser) {
  if (browser) await browser.close().catch(() => {});
}

module.exports = { launchBrowser, navigate, clickElement, fillField, readPage, takeScreenshot, uploadFile, downloadFile, closeBrowser };
