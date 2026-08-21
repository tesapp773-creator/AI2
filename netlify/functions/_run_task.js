// netlify/functions/_run_task.js
//
// The shared "manager loop" — Groq decides which tool(s) a goal needs,
// executes them, feeds results back, repeats until done. Used by both
// agent-background.js (on-demand tasks from the app) and
// scheduled-runner.js (recurring tasks that run automatically).

const {
  githubWriteFile,
  githubCreatePullRequest,
  githubUndoLastCommit,
  githubListRepos,
  githubCreateRepo,
  githubDeleteRepo,
  netlifyDeploy,
  netlifyCreateSite,
  netlifySetEnvVars,
  netlifyTriggerBuild,
  netlifyCheckDeployStatus,
  netlifyWaitForDeploy,
  aiDelegate,
  searchWeb,
  sendNotificationEmail,
  sendNotificationWhatsApp,
  sendPushNotification,
  checkEmail,
  sendEmail,
  recallMemory,
  saveMemory,
  forgetMemory,
  listAllMemory,
  checkCalendar,
  createCalendarEvent,
  generateImage,
  runCode,
  transcribeAudio,
  getYoutubeTranscript,
  ocrImage,
  listDriveFiles,
  readDriveFile,
  uploadDriveFile,
  scheduleTask,
  listScheduledTasks,
  cancelScheduledTask,
} = require("./_tools");
const {
  launchBrowser,
  navigate: browserNavigate,
  clickElement,
  fillField,
  readPage,
  takeScreenshot,
  uploadFile,
  downloadFile,
  closeBrowser,
} = require("./_browser");
const { generatePdf, generateDocx, generateXlsx, generatePptx } = require("./_documents");

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
// Supports multiple backup keys, so a rate limit on one account doesn't
// stop the task — GROQ_API_KEY is required, GROQ_API_KEY_2 / _3 are
// optional extra accounts to rotate through when one gets rate-limited.
const GROQ_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean);
const GEMINI_KEYS = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean);
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MAX_TURNS = 14; // multi-step browser tasks (navigate, fill several fields, click, verify) need more room than a simple search

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the live web for current information (news, facts, listings, anything you don't already know). Returns top results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The search query." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page and return its readable text content. Use this for simple reading — prefer this over browser_navigate unless you actually need to click, fill forms, or the page requires JavaScript to render.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The URL to fetch." } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Open a real browser and go to a URL — use this (not fetch_url) when you need to interact with a site: click things, fill in forms, or read a page that needs JavaScript. Returns the page title and a list of clickable/fillable elements, each with an id you can use with browser_click / browser_fill.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The URL to open." } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click an element on the currently open page, by its id (from the elements list returned by browser_navigate or the previous browser action). Returns the updated page state after clicking.",
      parameters: {
        type: "object",
        properties: { elementId: { type: "string", description: "The element's id, e.g. \"4\"." } },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fill",
      description: "Type text into an input/textarea on the currently open page, by its id.",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "The element's id, e.g. \"2\"." },
          text: { type: "string", description: "The text to type into it." },
        },
        required: ["elementId", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_read_page",
      description: "Read the full visible text of the currently open page — use this to verify a result, e.g. after submitting a form, to confirm what actually happened.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Take a screenshot of the currently open page and get back a URL to it. Use this to show the user what a page looks like, or as visual proof of a result.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_upload_file",
      description: "Upload a file into a file-input element on the currently open page (e.g. a resume, image, or document upload field). The file content has to come from somewhere real — give EITHER sourceUrl (a link to fetch the file from) OR fileContent (literal text to write out as the file, e.g. text the user attached to this task).",
      parameters: {
        type: "object",
        properties: {
          elementId: { type: "string", description: "The file input element's id." },
          sourceUrl: { type: "string", description: "A URL to download the file from first." },
          fileContent: { type: "string", description: "Literal text content to upload as the file (use this OR sourceUrl, not both)." },
          fileName: { type: "string", description: "Name to give the file, e.g. \"resume.pdf\" or \"notes.txt\". Include the right extension." },
        },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_download_file",
      description: "Click a download link/button on the currently open page and capture the resulting file, saving it and returning a URL the user can access it from (there's no other way to hand a downloaded file back to the user).",
      parameters: {
        type: "object",
        properties: { elementId: { type: "string", description: "The element that triggers the download when clicked." } },
        required: ["elementId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_list_repos",
      description: "List the user's GitHub repos (name + owner). Use this first if the user names a repo loosely or you're not sure of its exact name/spelling.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "github_create_repo",
      description: "Create a brand-new GitHub repository under the user's account.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Repo name, e.g. \"my-new-project\"." },
          description: { type: "string" },
          isPrivate: { type: "boolean", description: "true for a private repo, false (default) for public." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_delete_repo",
      description: "PERMANENTLY delete a GitHub repository. This is IRREVERSIBLE. STRICT RULE: only call this tool if the user's message in THIS SAME goal already contains an explicit, unambiguous confirmation to delete that exact repo (e.g. they said \"yes, delete it\", \"confirm\", or clearly asked to delete it more than once). If a goal ONLY asks to delete a repo without prior confirmation, do NOT call this tool — instead reply asking the user to confirm the exact repo name and that they understand it cannot be undone, and stop there. When you do call it, set confirmed to true.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "\"owner/repo\" — the exact repo to delete." },
          confirmed: { type: "boolean", description: "Must be true, and only true if the user explicitly confirmed in this same goal." },
        },
        required: ["repo", "confirmed"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_write_file",
      description: "Create or update a single file directly on the main branch of a GitHub repo. Works on ANY repo the user's token can access, not just one fixed repo — always pass 'repo' as \"owner/repo\" if the user names a repo (use github_list_repos first if unsure of the exact name).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path in the repo, e.g. src/index.js" },
          content: { type: "string", description: "Full new file content." },
          message: { type: "string", description: "Commit message." },
          repo: { type: "string", description: "\"owner/repo\" to act on. Omit only if the user didn't name a specific repo." },
        },
        required: ["path", "content", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_create_pull_request",
      description: "Create a new branch with one or more file changes and open a pull request, on any repo the token can access. Use this instead of github_write_file when the change should be reviewed before merging.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          repo: { type: "string", description: "\"owner/repo\" to act on. Omit only if the user didn't name a specific repo." },
          files: {
            type: "array",
            items: {
              type: "object",
              properties: { path: { type: "string" }, content: { type: "string" } },
              required: ["path", "content"],
            },
          },
        },
        required: ["title", "files"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_undo_last_commit",
      description: "Undo the most recent commit on a branch by moving the branch back to its parent commit. This rewrites history (like a force-push reset), so only use it when the user explicitly asks to undo/revert their last change — never proactively.",
      parameters: {
        type: "object",
        properties: {
          branch: { type: "string", description: "Branch to undo on, defaults to \"main\"." },
          repo: { type: "string", description: "\"owner/repo\" to act on. Omit only if the user didn't name a specific repo." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "netlify_deploy",
      description: "Trigger a new Netlify deploy for the configured site.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "netlify_create_site",
      description: "Create a brand-new Netlify site/project. If linked to a repo (usually a new one, created first with github_create_repo), it auto-deploys on push. If the site needs its own secrets/tokens to actually work (e.g. it's another copy of an app needing API keys), pass 'envVars' — this sets them on the new site, triggers a fresh build, WAITS for it to finish, and reports the real result (success or the actual error) rather than assuming it worked.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Optional custom site name/subdomain." },
          repo: { type: "string", description: "\"owner/repo\" to link for auto-deploy. Omit for an empty, unlinked site." },
          envVars: {
            type: "object",
            description: "Key-value pairs of environment variables to set on the new site, e.g. {\"GROQ_API_KEY\": \"...\"}. Only include this if the user gave you values to set, or explicitly wants the site fully configured, not just created.",
            additionalProperties: { type: "string" },
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "netlify_check_deploy_status",
      description: "Check whether a Netlify site's most recent deploy actually succeeded, is still building, or failed (with the real error if it failed). Use this instead of assuming a deploy worked.",
      parameters: {
        type: "object",
        properties: { siteId: { type: "string", description: "The Netlify site ID (returned when the site was created)." } },
        required: ["siteId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_email",
      description: "Read/search the user's recent inbox messages (subject, sender, date).",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword to filter by subject or sender." },
          limit: { type: "number", description: "How many recent messages to check, default 10." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_email",
      description: "Send an email on the user's behalf to any recipient (sent via the user's own Gmail account).",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ai_delegate",
      description: "Delegate a complex reasoning, writing, or coding sub-task to another free AI model and get back its answer.",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "The sub-task/prompt to send." },
          provider: { type: "string", enum: ["groq", "gemini"], description: "Which AI to delegate to. \"groq\" (default) uses a bigger Groq model. \"gemini\" uses Google Gemini's free tier — use this if the user specifically asks for Gemini or \"another AI\"." },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a fact worth remembering for future tasks (e.g. a preference, a recurring detail, an answer the user gave to your question). Use this whenever the user tells you something durable that would help later tasks.",
      parameters: {
        type: "object",
        properties: { fact: { type: "string", description: "The fact to remember, written plainly." } },
        required: ["fact"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_memory",
      description: "Delete a previously remembered fact (or facts) that match a word or phrase. Use this when the user says to forget, correct, or update something you remember.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A word or phrase to match against remembered facts, e.g. \"favorite color\"." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memory",
      description: "List everything currently remembered about the user. Use this when the user asks what you remember, or to check for outdated/duplicate facts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "check_calendar",
      description: "List the user's upcoming Google Calendar events. Defaults to the next 7 days if no range is given.",
      parameters: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "ISO 8601 start of range, e.g. 2026-08-14T00:00:00Z. Omit for now." },
          timeMax: { type: "string", description: "ISO 8601 end of range. Omit for 7 days from timeMin." },
          maxResults: { type: "number", description: "Max events to return, default 15." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create a new event on the user's Google Calendar.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title." },
          description: { type: "string" },
          startDateTime: { type: "string", description: "ISO 8601 start time, e.g. 2026-08-20T14:00:00" },
          endDateTime: { type: "string", description: "ISO 8601 end time." },
          timeZone: { type: "string", description: "IANA timezone, e.g. Africa/Lagos. Defaults to UTC if omitted." },
        },
        required: ["summary", "startDateTime", "endDateTime"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description: "Generate an image from a text description and get back a URL to it. Use this whenever the user asks for an image, picture, illustration, artwork, etc. to be created.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "A clear, detailed description of the image to generate." },
          width: { type: "number", description: "Image width in pixels, default 1024." },
          height: { type: "number", description: "Image height in pixels, default 1024." },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_pdf",
      description: "Create a real PDF document and get back a download URL. Good for reports, letters, simple formatted documents.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Document title, shown large at the top." },
          content: { type: "array", items: { type: "string" }, description: "Paragraphs of body text, in order." },
          fileName: { type: "string", description: "e.g. \"report.pdf\". Defaults to document.pdf." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_docx",
      description: "Create a real Word (.docx) document and get back a download URL. Supports headings, unlike generate_pdf.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          content: {
            type: "array",
            description: "One item per paragraph. For a body paragraph, only set text. For a heading, also set heading to 1, 2, or 3.",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                heading: { type: "number", description: "1, 2, or 3 for a heading. Omit for a normal body paragraph." },
              },
              required: ["text"],
            },
          },
          fileName: { type: "string", description: "e.g. \"letter.docx\". Defaults to document.docx." },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_xlsx",
      description: "Create a real Excel (.xlsx) spreadsheet and get back a download URL.",
      parameters: {
        type: "object",
        properties: {
          sheetName: { type: "string", description: "Defaults to Sheet1." },
          headers: { type: "array", items: { type: "string" }, description: "Column headers, first row." },
          rows: {
            type: "array",
            description: "Each item is an array of cell values for one row, e.g. [[\"Alice\", 90], [\"Bob\", 85]].",
            items: { type: "array" },
          },
          fileName: { type: "string", description: "e.g. \"data.xlsx\". Defaults to spreadsheet.xlsx." },
        },
        required: ["rows"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_pptx",
      description: "Create a real PowerPoint (.pptx) presentation and get back a download URL.",
      parameters: {
        type: "object",
        properties: {
          slides: {
            type: "array",
            description: "One item per slide.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                bullets: { type: "array", items: { type: "string" }, description: "Bullet points for this slide." },
              },
              required: ["title"],
            },
          },
          fileName: { type: "string", description: "e.g. \"pitch.pptx\". Defaults to presentation.pptx." },
        },
        required: ["slides"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description: "Actually RUN code in a real sandboxed environment and get the real output (stdout/stderr) — unlike writing code to a file, this verifies it actually works. Use this to test/verify code before committing it, or whenever the user wants to know what a piece of code actually outputs.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The full source code to run." },
          language: { type: "string", description: "python (default), javascript, java, c, cpp, go, ruby, php, or bash." },
          stdin: { type: "string", description: "Optional input to feed the program via stdin." },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "transcribe_audio",
      description: "Transcribe an audio file (from a URL) into text. Use this for voice notes, recordings, podcasts — anything audio the user wants converted to text or summarized.",
      parameters: {
        type: "object",
        properties: { audioUrl: { type: "string", description: "A direct URL to the audio file." } },
        required: ["audioUrl"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_youtube_transcript",
      description: "Get the real transcript/captions of a YouTube video. Use this to summarize or answer questions about a YouTube video — reads its actual spoken content, doesn't guess from the title.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The YouTube video URL." } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ocr_image",
      description: "Extract text from a photo/image (a receipt, document, sign, screenshot, business card, handwritten note, etc.) via a URL. If the user attached an image to this task, its URL will be included in the goal — use that URL here.",
      parameters: {
        type: "object",
        properties: { imageUrl: { type: "string", description: "A direct URL to the image." } },
        required: ["imageUrl"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_drive_files",
      description: "List/search the user's Google Drive files.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional text to search for in file names. Omit to list recent files." },
          maxResults: { type: "number", description: "Default 15." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_drive_file",
      description: "Read the text content of a Google Drive file (Google Docs/Sheets are exported as text/CSV automatically). Use list_drive_files first if you don't have the file's id.",
      parameters: {
        type: "object",
        properties: { fileId: { type: "string", description: "The Drive file id, from list_drive_files." } },
        required: ["fileId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upload_drive_file",
      description: "Create a new file in the user's Google Drive with the given text content.",
      parameters: {
        type: "object",
        properties: {
          fileName: { type: "string" },
          content: { type: "string", description: "The text content of the file." },
          mimeType: { type: "string", description: "Defaults to text/plain." },
        },
        required: ["fileName", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_task",
      description: "Set up a goal to run automatically and repeatedly (e.g. \"every day\", \"every hour\", \"every week\") without the user asking again. Use this when the user says things like \"every day\", \"daily\", \"each morning\", \"every week\", or \"keep checking\".",
      parameters: {
        type: "object",
        properties: {
          goal: { type: "string", description: "The goal to run repeatedly, written as a standalone instruction." },
          frequency: { type: "string", enum: ["hourly", "daily", "weekly"], description: "How often to run it." },
        },
        required: ["goal", "frequency"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_scheduled_tasks",
      description: "List the user's recurring/scheduled tasks and how often each runs. Use this when the user asks what's scheduled.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_scheduled_task",
      description: "Stop a recurring task that matches a word or phrase from its goal. Use this when the user says to stop, cancel, or remove a scheduled/recurring task.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A word or phrase to match against scheduled task goals." } },
        required: ["query"],
      },
    },
  },
];

async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (MKDAI agent)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return { error: `Fetch failed with status ${res.status}` };
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { text: text.slice(0, 12000) };
  } catch (err) {
    clearTimeout(timeout);
    return { error: `Could not fetch that page (${err.message})` };
  }
}

// Takes a screenshot and logs its URL directly into the live steps feed —
// this is separate from the model's own context (steps aren't resent to
// the AI), so it adds zero token cost but lets the app show what the
// browser is actually seeing as it goes, not just after the fact.
// Best-effort: a failed screenshot should never break the task.
async function snapshotStep(page, supabase, steps) {
  try {
    const { screenshotUrl } = await takeScreenshot(page, supabase);
    steps.push(screenshotUrl);
  } catch {
    // Screenshot capture is a nice-to-have for live progress, not
    // essential — silently skip on failure.
  }
}

async function runTool(name, args, steps, supabase, browserSession) {
  try {
    switch (name) {
      case "search_web": {
        steps.push(`Searching the web for "${args.query}"...`);
        return await searchWeb(args);
      }
      case "fetch_url": {
        steps.push(`Fetching ${args.url} ...`);
        return await fetchPageText(args.url);
      }
      case "browser_navigate": {
        steps.push(`Opening a browser and going to ${args.url}...`);
        if (!browserSession.browser) {
          const { browser, page } = await launchBrowser();
          browserSession.browser = browser;
          browserSession.page = page;
        }
        const navResult = await browserNavigate(browserSession.page, args.url);
        await snapshotStep(browserSession.page, supabase, steps);
        return navResult;
      }
      case "browser_click": {
        steps.push(`Clicking element ${args.elementId} on the page...`);
        if (!browserSession.page) throw new Error("No browser page open yet — call browser_navigate first.");
        const clickResult = await clickElement(browserSession.page, args.elementId);
        await snapshotStep(browserSession.page, supabase, steps);
        return clickResult;
      }
      case "browser_fill": {
        steps.push(`Filling element ${args.elementId}...`);
        if (!browserSession.page) throw new Error("No browser page open yet — call browser_navigate first.");
        return await fillField(browserSession.page, args.elementId, args.text);
      }
      case "browser_read_page": {
        steps.push("Reading the current page...");
        if (!browserSession.page) throw new Error("No browser page open yet — call browser_navigate first.");
        return await readPage(browserSession.page);
      }
      case "browser_screenshot": {
        steps.push("Taking a screenshot...");
        if (!browserSession.page) throw new Error("No browser page open yet — call browser_navigate first.");
        return await takeScreenshot(browserSession.page, supabase);
      }
      case "browser_upload_file": {
        steps.push(`Uploading a file to element ${args.elementId}...`);
        if (!browserSession.page) throw new Error("No browser page open yet — call browser_navigate first.");
        return await uploadFile(browserSession.page, args);
      }
      case "browser_download_file": {
        steps.push(`Downloading via element ${args.elementId}...`);
        if (!browserSession.page) throw new Error("No browser page open yet — call browser_navigate first.");
        return await downloadFile(browserSession.page, supabase, args.elementId);
      }
      case "github_list_repos": {
        steps.push("Listing your GitHub repos...");
        return await githubListRepos();
      }
      case "github_create_repo": {
        steps.push(`Creating a new GitHub repo: ${args.name}...`);
        return await githubCreateRepo(args);
      }
      case "github_delete_repo": {
        steps.push(`Deleting GitHub repo ${args.repo} (confirmed by user)...`);
        return await githubDeleteRepo(args);
      }
      case "github_write_file": {
        steps.push(`Writing ${args.path} to ${args.repo || "the default repo"}...`);
        return await githubWriteFile(args);
      }
      case "github_create_pull_request": {
        steps.push(`Opening a pull request on ${args.repo || "the default repo"}: ${args.title}`);
        return await githubCreatePullRequest(args);
      }
      case "github_undo_last_commit": {
        steps.push(`Undoing the last commit on ${args.repo || "the default repo"}...`);
        return await githubUndoLastCommit(args);
      }
      case "netlify_deploy": {
        steps.push("Triggering a Netlify deploy...");
        return await netlifyDeploy();
      }
      case "netlify_create_site": {
        steps.push(`Creating a new Netlify site${args.repo ? ` linked to ${args.repo}` : ""}...`);
        const site = await netlifyCreateSite(args);
        if (args.envVars && Object.keys(args.envVars).length > 0 && site.siteId) {
          steps.push(`Setting ${Object.keys(args.envVars).length} environment variable(s) on the new site...`);
          await netlifySetEnvVars({ siteId: site.siteId, vars: args.envVars });
          steps.push("Triggering a fresh build with the new environment variables...");
          await netlifyTriggerBuild({ siteId: site.siteId });
          steps.push("Waiting for the deploy to finish so I can confirm it actually worked...");
          const deployResult = await netlifyWaitForDeploy({ siteId: site.siteId });
          return { ...site, deployStatus: deployResult };
        }
        return site;
      }
      case "netlify_check_deploy_status": {
        steps.push("Checking the real deploy status...");
        return await netlifyCheckDeployStatus(args);
      }
      case "check_email": {
        steps.push("Checking your inbox...");
        return await checkEmail(args);
      }
      case "send_email": {
        steps.push(`Sending an email to ${args.to}...`);
        return await sendEmail(args);
      }
      case "ai_delegate": {
        steps.push(`Delegating a sub-task to ${args.provider || "groq"}...`);
        return await aiDelegate(args);
      }
      case "save_memory": {
        steps.push("Remembering that for next time...");
        return await saveMemory(supabase, args);
      }
      case "forget_memory": {
        steps.push(`Forgetting anything matching "${args.query}"...`);
        return await forgetMemory(supabase, args);
      }
      case "list_memory": {
        steps.push("Listing everything remembered...");
        return await listAllMemory(supabase);
      }
      case "check_calendar": {
        steps.push("Checking the calendar...");
        return await checkCalendar(args);
      }
      case "create_calendar_event": {
        steps.push(`Creating calendar event: ${args.summary}...`);
        return await createCalendarEvent(args);
      }
      case "generate_image": {
        steps.push(`Generating an image: "${args.prompt}"...`);
        return await generateImage(supabase, args);
      }
      case "generate_pdf": {
        steps.push(`Generating a PDF: ${args.fileName || "document.pdf"}...`);
        return await generatePdf(supabase, args);
      }
      case "generate_docx": {
        steps.push(`Generating a Word document: ${args.fileName || "document.docx"}...`);
        return await generateDocx(supabase, args);
      }
      case "generate_xlsx": {
        steps.push(`Generating a spreadsheet: ${args.fileName || "spreadsheet.xlsx"}...`);
        return await generateXlsx(supabase, args);
      }
      case "generate_pptx": {
        steps.push(`Generating a presentation: ${args.fileName || "presentation.pptx"}...`);
        return await generatePptx(supabase, args);
      }
      case "run_code": {
        steps.push(`Running ${args.language || "python"} code...`);
        return await runCode(args);
      }
      case "transcribe_audio": {
        steps.push("Transcribing audio...");
        return await transcribeAudio(args);
      }
      case "get_youtube_transcript": {
        steps.push(`Getting the transcript for ${args.url}...`);
        return await getYoutubeTranscript(args);
      }
      case "ocr_image": {
        steps.push("Reading text from the image...");
        return await ocrImage(args);
      }
      case "list_drive_files": {
        steps.push("Listing Google Drive files...");
        return await listDriveFiles(args);
      }
      case "read_drive_file": {
        steps.push(`Reading Drive file ${args.fileId}...`);
        return await readDriveFile(args);
      }
      case "upload_drive_file": {
        steps.push(`Uploading ${args.fileName} to Google Drive...`);
        return await uploadDriveFile(args);
      }
      case "schedule_task": {
        steps.push(`Scheduling "${args.goal}" to run ${args.frequency}...`);
        return await scheduleTask(supabase, args);
      }
      case "list_scheduled_tasks": {
        steps.push("Listing scheduled tasks...");
        return await listScheduledTasks(supabase);
      }
      case "cancel_scheduled_task": {
        steps.push(`Cancelling scheduled task matching "${args.query}"...`);
        return await cancelScheduledTask(supabase, args);
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    steps.push(`${name} failed: ${err.message}`);
    return { error: err.message };
  }
}

async function callGroq(messages, apiKey) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

// --- Gemini fallback ---
// Gemini has a different tool-calling shape than Groq's OpenAI-style API.
// These helpers translate the SAME OpenAI-style `messages` array the rest
// of the loop uses into Gemini's format and back, so runTask's loop below
// never needs to know which provider actually answered a given turn.

// Gemini's schema validation doesn't support every JSON Schema keyword we
// use for Groq (e.g. additionalProperties on a free-form object) — strip
// anything it's known to reject rather than risk the whole call failing.
function sanitizeSchemaForGemini(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const clone = Array.isArray(schema) ? [...schema] : { ...schema };
  delete clone.additionalProperties;
  for (const key of Object.keys(clone)) {
    if (clone[key] && typeof clone[key] === "object") {
      clone[key] = sanitizeSchemaForGemini(clone[key]);
    }
  }
  return clone;
}

const GEMINI_TOOLS = [
  {
    function_declarations: TOOLS.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeSchemaForGemini(t.function.parameters),
    })),
  },
];

function messagesToGeminiContents(messages) {
  const contents = [];
  const idToName = {};
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content || "" }] });
    } else if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length) {
        const parts = m.tool_calls.map((call) => {
          idToName[call.id] = call.function.name;
          let args = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            // leave args empty if malformed
          }
          return { functionCall: { name: call.function.name, args }, thoughtSignature: "skip_thought_signature_validator" };
        });
        contents.push({ role: "model", parts });
      } else {
        contents.push({ role: "model", parts: [{ text: m.content || "" }] });
      }
    } else if (m.role === "tool") {
      const name = idToName[m.tool_call_id] || "unknown_function";
      let responseObj;
      try {
        responseObj = JSON.parse(m.content);
      } catch {
        responseObj = { result: m.content };
      }
      contents.push({ role: "user", parts: [{ functionResponse: { name, response: responseObj } }] });
    }
  }
  return contents;
}

// Converts Gemini's response back into the same shape callGroq returns
// (an OpenAI-style assistant message), so the rest of the loop is identical
// regardless of which provider actually handled the turn.
function geminiResponseToMessage(data) {
  const candidate = data.candidates && data.candidates[0];
  const parts = (candidate && candidate.content && candidate.content.parts) || [];
  const functionCallParts = parts.filter((p) => p.functionCall);
  if (functionCallParts.length > 0) {
    const tool_calls = functionCallParts.map((p, i) => ({
      id: `gemini_call_${Date.now()}_${i}`,
      type: "function",
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    }));
    return { role: "assistant", content: null, tool_calls };
  }
  const text = parts.map((p) => p.text || "").join("");
  if (text) return { role: "assistant", content: text };
  // Empty output with no function call — surface WHY instead of a blank
  // "(no response)" so it's actually debuggable (e.g. safety filtering,
  // hitting max output tokens, or a genuinely empty turn).
  const finishReason = candidate && candidate.finishReason;
  const safetyBlocked = candidate && candidate.safetyRatings && candidate.safetyRatings.some((r) => r.blocked);
  const reason = safetyBlocked
    ? "Gemini's safety filter blocked this response."
    : finishReason
    ? `Gemini stopped without a full answer (reason: ${finishReason}).`
    : "Gemini returned an empty response for an unknown reason.";
  return { role: "assistant", content: `I wasn't able to finish this — ${reason} Try rephrasing the goal or breaking it into smaller steps.` };
}

async function callGemini(messages, apiKey) {
  const systemMsg = messages.find((m) => m.role === "system");
  const body = {
    contents: messagesToGeminiContents(messages),
    tools: GEMINI_TOOLS,
    // Disabling "thinking" avoids Gemini 3's mandatory thought_signature
    // requirement on function calls — our translation layer doesn't (and
    // can't cleanly) persist those signatures across a mixed Groq/Gemini
    // history, so the simplest reliable fix is to not generate them at all.
    generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
  };
  if (systemMsg) body.system_instruction = { parts: [{ text: systemMsg.content }] };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FALLBACK_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
  }
  return geminiResponseToMessage(data);
}

// Tries every available Groq key in order (skipping to the next one only on
// a rate-limit error — any other kind of error fails immediately, since
// retrying a different key won't fix a real bug). If ALL Groq keys are
// rate-limited, falls through to trying every available Gemini key the
// same way. Only fails the whole task if every single key is exhausted.
async function callModel(messages, steps) {
  if (GROQ_KEYS.length === 0) {
    throw new Error("No GROQ_API_KEY is set on the server. Add it in Netlify > Site configuration > Environment variables, then redeploy.");
  }
  let lastErr;
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    try {
      return await callGroq(messages, GROQ_KEYS[i]);
    } catch (err) {
      lastErr = err;
      if (!/429|rate.?limit/i.test(err.message)) throw err;
      if (i < GROQ_KEYS.length - 1) steps.push(`Groq key ${i + 1} hit a rate limit — trying backup key ${i + 2}...`);
    }
  }
  if (GEMINI_KEYS.length === 0) {
    throw new Error(`All Groq keys are rate-limited, and no GEMINI_API_KEY is set as a fallback. Last error: ${lastErr.message}`);
  }
  steps.push("All Groq keys are rate-limited — switching to Gemini...");
  for (let i = 0; i < GEMINI_KEYS.length; i++) {
    try {
      return await callGemini(messages, GEMINI_KEYS[i]);
    } catch (err) {
      lastErr = err;
      if (i < GEMINI_KEYS.length - 1) steps.push(`Gemini key ${i + 1} failed (${err.message.slice(0, 80)}) — trying backup key ${i + 2}...`);
    }
  }
  throw new Error(`All Groq and Gemini keys failed. Last error: ${lastErr.message}`);
}

// Keeps token usage roughly flat across a long task instead of compounding
// every turn — see the comment where this is called for why it matters.
function trimOldToolResults(messages, keepRecent = 4) {
  const toolIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }
  const toTrim = toolIndices.slice(0, Math.max(0, toolIndices.length - keepRecent));
  for (const i of toTrim) {
    if (messages[i].content.length > 150) {
      messages[i].content = "[earlier tool result omitted to save context space — re-run the tool if you need this again]";
    }
  }
}

// Runs one full task end to end: creates the task row, runs the manager
// loop, updates the row with the result, and emails the user. Used for
// both on-demand tasks and recurring scheduled tasks.
async function runTask(supabase, { goal, fileText, conversationId }) {
  if (GROQ_KEYS.length === 0) {
    throw new Error("GROQ_API_KEY is not set on the server. Add it in Netlify > Site configuration > Environment variables, then redeploy.");
  }

  // Conversations group related tasks into a thread. Since this runs as a
  // fire-and-forget background function, the caller never actually
  // receives this function's return value — so the frontend generates its
  // own conversation id up front (for a "new chat") and we create the row
  // here on first use, rather than relying on a server-generated id we
  // couldn't hand back anyway.
  let convoId = conversationId;
  if (convoId) {
    const { data: existing } = await supabase
      .from("mkdai_conversations")
      .select("id")
      .eq("id", convoId)
      .maybeSingle();
    if (existing) {
      await supabase.from("mkdai_conversations").update({ updated_at: new Date().toISOString() }).eq("id", convoId);
    } else {
      const { error: createError } = await supabase
        .from("mkdai_conversations")
        .insert({ id: convoId, title: goal.slice(0, 60) });
      if (createError) throw new Error(`Database error creating conversation: ${createError.message}`);
    }
  } else {
    const { data: convo, error: convoError } = await supabase
      .from("mkdai_conversations")
      .insert({ title: goal.slice(0, 60) })
      .select("id")
      .single();
    if (convoError) throw new Error(`Database error creating conversation: ${convoError.message}`);
    convoId = convo.id;
  }

  const { data, error } = await supabase
    .from("mkdai_tasks")
    .insert({ goal, status: "running", conversation_id: convoId })
    .select("id")
    .single();
  if (error) throw new Error(`Database error: ${error.message}`);
  const taskId = data.id;

  const steps = [];
  const memoryFacts = await recallMemory(supabase);
  const memorySection = memoryFacts.length
    ? `\n\nThings you already know about the user from past tasks (use these, don't ask again if already answered here):\n- ${memoryFacts.join("\n- ")}`
    : "";

  // Pull recent turns from THIS conversation thread so follow-ups actually
  // work — "undo that", "now do X with it", "what did you find" all need
  // the real prior exchange, not just the general memory facts above.
  const { data: priorTasks } = await supabase
    .from("mkdai_tasks")
    .select("goal, answer, status, created_at")
    .eq("conversation_id", convoId)
    .neq("id", taskId)
    .order("created_at", { ascending: false })
    .limit(6);
  const threadHistory = (priorTasks || []).reverse().filter((t) => t.status === "done" && t.answer);

  const systemPrompt = `You are MKDAI, a personal manager agent. You have real tools: search_web (search the live web for current info), fetch_url (read a specific web page), github_list_repos (list the user's repos), github_create_repo (create a brand-new repo), github_delete_repo (PERMANENTLY delete a repo — see strict rule below), github_write_file / github_create_pull_request / github_undo_last_commit (act on ANY of the user's GitHub repos, including undoing the last commit if the user explicitly asks — pass 'repo' as "owner/repo" when the user names one, using github_list_repos first if you're not sure of the exact spelling), netlify_deploy (trigger a deploy for the main site), netlify_create_site (create a brand-new Netlify site, optionally linked to a GitHub repo, and optionally with its own environment variables set — when envVars are given it waits for the real deploy result instead of assuming success), netlify_check_deploy_status (check whether a site's latest deploy actually succeeded, is building, or failed, with the real error if it failed), check_email (read/search the user's inbox), send_email (send an email on the user's behalf), check_calendar / create_calendar_event (view or create Google Calendar events), generate_image (create an image from a text description and get back a URL), generate_pdf / generate_docx / generate_xlsx / generate_pptx (create a real, downloadable PDF, Word, Excel, or PowerPoint file — use these whenever the user wants an actual document, spreadsheet, or presentation, not just text in the chat), run_code (actually EXECUTE code in a real sandbox and get the real stdout/stderr — use this to verify code works before committing it, or whenever asked what code actually outputs, not just to write code), transcribe_audio (turn an audio file into text), get_youtube_transcript (get a YouTube video's real transcript/captions — use this to summarize or answer questions about a video, don't guess from the title/URL alone), ocr_image (extract text from a photo/image via URL — use this for photos of receipts, documents, signs, handwritten notes; if the user attached an image, its URL is included in the goal text), list_drive_files / read_drive_file / upload_drive_file (search, read, or create files in the user's Google Drive), browser_navigate / browser_click / browser_fill / browser_read_page / browser_screenshot / browser_upload_file / browser_download_file (control a real browser to interact with a website like a human — click, fill forms, upload a file into a form, download a file and get a URL to it, read what's on the page, verify a result, or take a screenshot; prefer fetch_url for simple reading, use these only when you actually need to interact with a page or it needs JavaScript to load — if the user gives you an email/username/password directly in a goal to log in or register somewhere, treat it as their own account and use it as instructed, don't refuse or ask whether it's really theirs). IMPORTANT: there is no "find element" or "search page" tool — browser_navigate and browser_click always return the current list of clickable/fillable elements (each with an id and its visible text); to find something specific, look through that returned elements list yourself and use the matching id with browser_click/browser_fill. If what you need isn't in the list, try browser_read_page for more context, or click through the page step by step — never call a tool that isn't in your actual tool list.), ai_delegate (hand a sub-task to another free AI model for deeper reasoning or coding — Groq by default, or Gemini if the user asks for it by name), save_memory / forget_memory / list_memory (manage durable facts about the user across tasks), and schedule_task / list_scheduled_tasks / cancel_scheduled_task (set up, view, or stop goals that run automatically on a recurring schedule — hourly, daily, or weekly — without the user asking again). Use tools when the user's goal actually requires an action or current information you don't have — prefer search_web for anything current (news, listings, facts) rather than guessing from memory. When a tool isn't configured (missing token) it will return an error — tell the user plainly which token is missing rather than pretending you did the action. When you create a Netlify site with envVars, or check a deploy status, report the actual deployStatus/state truthfully (e.g. "ready", "error", "building", "timed_out") — never tell the user a deploy succeeded unless the state is "ready". This goal is part of an ongoing conversation thread — if earlier turns are shown below, treat follow-ups like "undo that", "now do X with it", or "what did you find" as referring to that recent history. Once you have everything you need, reply with a clear, concrete final answer and no further tool calls. CRITICAL SAFETY RULE: repo deletion is the one action that always needs the user's explicit confirmation first, even though everything else runs without asking — never call github_delete_repo on a first request to delete something; ask for confirmation in your answer instead, and only delete once the user has clearly confirmed in their own words.${memorySection}`;

  const userContent = fileText
    ? `${goal}\n\nAttached file content:\n${fileText.slice(0, 12000)}`
    : goal;

  const messages = [{ role: "system", content: systemPrompt }];
  for (const t of threadHistory) {
    messages.push({ role: "user", content: t.goal });
    messages.push({ role: "assistant", content: t.answer.slice(0, 1500) });
  }
  messages.push({ role: "user", content: userContent });

  // Shared across all tool calls in this task, so browser_navigate ->
  // browser_click -> browser_read_page etc. all act on the SAME open page.
  // Always closed below, whether the task succeeds or fails, so no
  // Chromium process is ever left running.
  const browserSession = { browser: null, page: null };

  try {
    let finalAnswer = null;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const message = await callModel(messages, steps);
      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        finalAnswer = message.content || "(no response)";
        break;
      }

      for (const call of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // leave args empty if the model produced malformed JSON
        }
        const result = await runTool(call.function.name, args, steps, supabase, browserSession);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 2500),
        });
      }

      // Every turn resends the ENTIRE conversation so far — on long,
      // multi-step tasks (browser automation especially, with full page
      // dumps and element lists each step) that grows very expensive very
      // fast. Trimming older tool results down to a placeholder once a few
      // newer turns exist keeps token usage roughly flat instead of
      // compounding, which is what actually makes a limited free-tier
      // quota stretch across a whole task.
      trimOldToolResults(messages);

      // Save progress after every turn (not just at the end) so the app
      // can show what's actually happening live instead of a static
      // "Still working..." message. Best-effort — a failed progress write
      // should never break the task itself.
      await supabase
        .from("mkdai_tasks")
        .update({ steps, updated_at: new Date().toISOString() })
        .eq("id", taskId)
        .then(null, () => {});

      // Background functions can't be force-killed from outside, so
      // cancellation is cooperative: the app sets cancel_requested, and
      // the task checks it between turns and stops itself cleanly.
      const { data: cancelCheck } = await supabase
        .from("mkdai_tasks")
        .select("cancel_requested")
        .eq("id", taskId)
        .single();
      if (cancelCheck && cancelCheck.cancel_requested) {
        steps.push("Stopped by user request.");
        await supabase
          .from("mkdai_tasks")
          .update({ status: "cancelled", answer: "Stopped before finishing, at your request.", steps, updated_at: new Date().toISOString() })
          .eq("id", taskId);
        return { id: taskId, conversationId: convoId, answer: "Stopped before finishing, at your request.", sources: [], steps };
      }
    }

    if (finalAnswer === null) {
      finalAnswer = "I ran out of steps working on this — try breaking the goal into a smaller request.";
    }

    // A quick "how much work did this actually take" summary — reads well
    // as a small badge in the UI and is genuinely useful proof of what
    // happened, not just decoration.
    const toolCalls = messages.filter((m) => m.role === "assistant" && m.tool_calls).flatMap((m) => m.tool_calls);
    const toolCount = toolCalls.length;
    const toolsUsed = [...new Set(toolCalls.map((c) => c.function.name))];

    steps.push("Done.");
    await supabase
      .from("mkdai_tasks")
      .update({
        status: "done",
        answer: finalAnswer,
        sources: [],
        steps,
        tool_count: toolCount,
        tools_used: toolsUsed,
        updated_at: new Date().toISOString(),
      })
      .eq("id", taskId);
    await sendNotificationEmail({ goal, status: "done", answer: finalAnswer });
    await sendNotificationWhatsApp({ goal, status: "done", answer: finalAnswer });
    await sendPushNotification(supabase, { goal, status: "done", answer: finalAnswer });

    return { id: taskId, conversationId: convoId, answer: finalAnswer, sources: [], steps };
  } catch (err) {
    await supabase
      .from("mkdai_tasks")
      .update({ status: "error", error: err.message, steps, updated_at: new Date().toISOString() })
      .eq("id", taskId);
    await sendNotificationEmail({ goal, status: "error", error: err.message });
    await sendNotificationWhatsApp({ goal, status: "error", error: err.message });
    await sendPushNotification(supabase, { goal, status: "error", error: err.message });
    throw err;
  } finally {
    await closeBrowser(browserSession.browser);
  }
}

module.exports = { runTask };
