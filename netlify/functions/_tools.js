// netlify/functions/_tools.js
//
// Real "worker" actions the manager can call. Each one requires its own
// token, read from environment variables set in Netlify (never hardcoded,
// never sent from the browser).

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
const NETLIFY_BUILD_HOOK_URL = process.env.NETLIFY_BUILD_HOOK_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_DELEGATE_MODEL = process.env.GROQ_DELEGATE_MODEL || "llama-3.3-70b-versatile";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const NETLIFY_API_TOKEN = process.env.NETLIFY_API_TOKEN;
const EMAIL_IMAP_USER = process.env.EMAIL_IMAP_USER;
const EMAIL_IMAP_APP_PASSWORD = process.env.EMAIL_IMAP_APP_PASSWORD;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886"; // Twilio's shared sandbox number
const NOTIFY_WHATSAPP_TO = process.env.NOTIFY_WHATSAPP_TO; // e.g. "whatsapp:+2348012345678"

function b64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

async function ghFetch(path, options = {}, repoOverride) {
  const repo = repoOverride || GITHUB_REPO;
  if (!GITHUB_TOKEN || !repo) {
    throw new Error("GITHUB_TOKEN and/or a repo (either GITHUB_REPO default, or a repo you name) is not set.");
  }
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}) on ${repo}: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

// List the user's repos, so the agent can match a name the user gave loosely
// (e.g. "my redbull repo") to the real repo name/spelling.
async function githubListRepos() {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not set in Netlify environment variables.");
  }
  const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) {
    throw new Error(`GitHub API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { repos: (data || []).map((r) => r.full_name) };
}

// Create a brand-new repo. Requires a classic PAT with "repo" scope —
// fine-grained tokens can't create repos (a GitHub API limitation).
async function githubCreateRepo({ name, description, isPrivate = false }) {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not set in Netlify environment variables.");
  }
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, description: description || "", private: isPrivate, auto_init: true }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 403 || res.status === 404
      ? " (this usually means GITHUB_TOKEN is a fine-grained token — creating repos needs a classic token with 'repo' scope)"
      : "";
    throw new Error(`GitHub API error (${res.status}) creating repo: ${JSON.stringify(data).slice(0, 300)}${hint}`);
  }
  return { repo: data.full_name, url: data.html_url };
}

// Permanently delete a repo. IRREVERSIBLE — the caller (see the system
// prompt / tool description) must only invoke this after the user has
// explicitly confirmed, in their own words, that they want THIS specific
// repo deleted. `confirmed` must literally be true, as a second guard.
// Requires a classic token with the separate 'delete_repo' scope — plain
// 'repo' scope is NOT enough for GitHub to allow this.
async function githubDeleteRepo({ repo, confirmed }) {
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN is not set in Netlify environment variables.");
  }
  if (!repo) {
    throw new Error("No repo specified to delete.");
  }
  if (confirmed !== true) {
    throw new Error("Deletion was not explicitly confirmed — refusing to delete. Ask the user to clearly confirm before calling this again.");
  }
  const res = await fetch(`https://api.github.com/repos/${repo}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status !== 204) {
    const data = await res.json().catch(() => ({}));
    const hint = res.status === 403
      ? " (the token likely lacks the 'delete_repo' scope — plain 'repo' scope doesn't allow deletion; generate a classic token with 'delete_repo' checked too)"
      : "";
    throw new Error(`GitHub API error (${res.status}) deleting repo: ${JSON.stringify(data).slice(0, 300)}${hint}`);
  }
  return { deleted: true, repo };
}

// Create or update a single file directly on a branch (default: main).
// `repo` is optional — "owner/repo"; falls back to GITHUB_REPO if omitted.
async function githubWriteFile({ path, content, message, branch = "main", repo }) {
  let sha;
  try {
    const existing = await ghFetch(`/contents/${encodeURIComponent(path)}?ref=${branch}`, {}, repo);
    sha = existing.sha;
  } catch {
    // File doesn't exist yet — that's fine, we're creating it.
  }
  const body = { message, content: b64(content), branch };
  if (sha) body.sha = sha;
  const result = await ghFetch(`/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  }, repo);
  return { path, repo: repo || GITHUB_REPO, commitUrl: result.commit && result.commit.html_url };
}

// Create a new branch off `base`, write one or more files to it, open a PR.
async function githubCreatePullRequest({ title, body, files, base = "main", branch, repo }) {
  const branchName = branch || `mkdai-${Date.now()}`;
  const baseRef = await ghFetch(`/git/ref/heads/${base}`, {}, repo);
  const baseSha = baseRef.object.sha;
  await ghFetch(`/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  }, repo);
  for (const f of files) {
    await githubWriteFile({ path: f.path, content: f.content, message: title, branch: branchName, repo });
  }
  const pr = await ghFetch(`/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body: body || "", head: branchName, base }),
  }, repo);
  return { prUrl: pr.html_url, branch: branchName, repo: repo || GITHUB_REPO };
}

// Undo the most recent commit on a branch by moving the branch pointer back
// to its parent commit. Note: this rewrites history (like `git reset --hard`
// + force push), not a safe "revert commit" — fine for personal/solo repos,
// but anyone else who already pulled that commit will have a mismatched
// history. Returns what was undone so the agent can confirm clearly.
async function githubUndoLastCommit({ branch = "main", repo }) {
  const ref = await ghFetch(`/git/refs/heads/${branch}`, {}, repo);
  const headSha = ref.object.sha;
  const commit = await ghFetch(`/commits/${headSha}`, {}, repo);
  if (!commit.parents || commit.parents.length === 0) {
    throw new Error("Can't undo — this is the very first commit on the branch, it has no parent to go back to.");
  }
  const parentSha = commit.parents[0].sha;
  await ghFetch(`/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: parentSha, force: true }),
  }, repo);
  return {
    repo: repo || GITHUB_REPO,
    branch,
    undoneCommitMessage: commit.commit && commit.commit.message,
    undoneCommitSha: headSha,
    newHeadSha: parentSha,
  };
}

// Trigger a Netlify deploy via a build hook (a secret URL from Netlify, not a token).
async function netlifyDeploy() {
  if (!NETLIFY_BUILD_HOOK_URL) {
    throw new Error("NETLIFY_BUILD_HOOK_URL is not set in Netlify environment variables.");
  }
  const res = await fetch(NETLIFY_BUILD_HOOK_URL, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Netlify build hook failed (${res.status})`);
  }
  return { triggered: true };
}

// Create a brand-new Netlify site, optionally linked to a GitHub repo so it
// auto-deploys on push. Requires a Netlify personal access token (different
// from the build hook URL used by netlifyDeploy).
async function netlifyCreateSite({ name, repo, branch = "main" }) {
  if (!NETLIFY_API_TOKEN) {
    throw new Error("NETLIFY_API_TOKEN is not set in Netlify environment variables.");
  }
  const body = {};
  if (name) body.name = name;
  if (repo) {
    body.repo = { provider: "github", repo, branch };
  }
  const res = await fetch("https://api.netlify.com/api/v1/sites", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NETLIFY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Netlify API error (${res.status}) creating site: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { siteId: data.site_id || data.id, siteUrl: data.ssl_url || data.url, adminUrl: data.admin_url, name: data.name };
}

// Netlify's env var API is scoped by "account" (team), not just site — this
// looks up the token owner's account id once, needed by netlifySetEnvVars.
async function netlifyGetAccountId() {
  const res = await fetch("https://api.netlify.com/api/v1/accounts", {
    headers: { Authorization: `Bearer ${NETLIFY_API_TOKEN}` },
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok || !data || !data[0]) {
    throw new Error(`Could not look up Netlify account (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data[0].id;
}

// Set one or more environment variables on a specific Netlify site. This is
// what lets a newly-created site actually work — without this, a site MKDAI
// creates has no keys/tokens of its own and its build/functions will fail.
async function netlifySetEnvVars({ siteId, vars }) {
  if (!NETLIFY_API_TOKEN) {
    throw new Error("NETLIFY_API_TOKEN is not set in Netlify environment variables.");
  }
  const accountId = await netlifyGetAccountId();
  const payload = Object.entries(vars).map(([key, value]) => ({
    key,
    scopes: ["builds", "functions", "runtime", "post-processing"],
    values: [{ value: String(value), context: "all" }],
  }));
  const res = await fetch(`https://api.netlify.com/api/v1/accounts/${accountId}/env?site_id=${siteId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NETLIFY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Netlify API error (${res.status}) setting env vars: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { set: Object.keys(vars) };
}

// Trigger a fresh build via the Netlify API (site-scoped, uses the personal
// access token — different from the build-hook-based netlifyDeploy above).
async function netlifyTriggerBuild({ siteId }) {
  if (!NETLIFY_API_TOKEN) {
    throw new Error("NETLIFY_API_TOKEN is not set in Netlify environment variables.");
  }
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/builds`, {
    method: "POST",
    headers: { Authorization: `Bearer ${NETLIFY_API_TOKEN}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Netlify API error (${res.status}) triggering build: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { deployId: data.deploy_id };
}

// Look up the actual current state of a site's latest deploy, instead of
// assuming a deploy succeeded just because it was triggered.
async function netlifyCheckDeployStatus({ siteId }) {
  if (!NETLIFY_API_TOKEN) {
    throw new Error("NETLIFY_API_TOKEN is not set in Netlify environment variables.");
  }
  const res = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys?per_page=1`, {
    headers: { Authorization: `Bearer ${NETLIFY_API_TOKEN}` },
  });
  const data = await res.json().catch(() => ([]));
  if (!res.ok) {
    throw new Error(`Netlify API error (${res.status}) checking deploy status: ${JSON.stringify(data).slice(0, 400)}`);
  }
  const deploy = data && data[0];
  if (!deploy) return { state: "no_deploys_yet" };
  return {
    state: deploy.state, // "new" | "building" | "ready" | "error" | ...
    deployUrl: deploy.deploy_ssl_url || deploy.deploy_url,
    errorMessage: deploy.error_message || null,
  };
}

// Poll a site's latest deploy until it finishes (ready/error) or times out.
// Used internally so tools can report the TRUE outcome of a deploy instead
// of just confirming it was triggered.
async function netlifyWaitForDeploy({ siteId, timeoutMs = 90000, intervalMs = 5000 }) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await netlifyCheckDeployStatus({ siteId });
    if (status.state === "ready" || status.state === "error" || status.state === "no_deploys_yet") {
      return status;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { state: "timed_out" };
}

// Read/search recent inbox messages via IMAP (works with a Gmail App
// Password — requires 2-Step Verification enabled on the Google account).
async function checkEmail({ query, limit = 10 }) {
  if (!EMAIL_IMAP_USER || !EMAIL_IMAP_APP_PASSWORD) {
    throw new Error("EMAIL_IMAP_USER and/or EMAIL_IMAP_APP_PASSWORD is not set in Netlify environment variables.");
  }
  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: EMAIL_IMAP_USER, pass: EMAIL_IMAP_APP_PASSWORD },
    logger: false,
  });
  const messages = [];
  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      const status = await client.status("INBOX", { messages: true });
      const total = status.messages || 0;
      if (total > 0) {
        const start = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${start}:${total}`, { envelope: true, bodyStructure: true })) {
          const subject = (msg.envelope && msg.envelope.subject) || "(no subject)";
          const from = msg.envelope && msg.envelope.from && msg.envelope.from[0]
            ? `${msg.envelope.from[0].name || ""} <${msg.envelope.from[0].address}>`
            : "(unknown sender)";
          const date = msg.envelope && msg.envelope.date;
          if (!query || subject.toLowerCase().includes(query.toLowerCase()) || from.toLowerCase().includes(query.toLowerCase())) {
            messages.push({ subject, from, date });
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return { messages: messages.reverse() };
}

// Send an email on the user's behalf via Gmail SMTP, reusing the same
// EMAIL_IMAP_USER / EMAIL_IMAP_APP_PASSWORD credentials already set up for
// reading the inbox. Unlike the free Resend tier, Gmail can send to ANY
// recipient — no domain verification needed.
async function sendEmail({ to, subject, body }) {
  if (!EMAIL_IMAP_USER || !EMAIL_IMAP_APP_PASSWORD) {
    throw new Error("EMAIL_IMAP_USER and/or EMAIL_IMAP_APP_PASSWORD is not set in Netlify environment variables (needed to send via Gmail).");
  }
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: EMAIL_IMAP_USER, pass: EMAIL_IMAP_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `MKDAI <${EMAIL_IMAP_USER}>`,
    to,
    subject,
    text: body,
  });
  return { sent: true, to, subject };
}

// Delegate a sub-task to another free AI model for deeper reasoning/coding
// help. provider: "groq" (default, reuses GROQ_API_KEY, no extra setup) or
// "gemini" (Google's free tier, needs GEMINI_API_KEY).
async function aiDelegate({ task, provider = "groq" }) {
  if (provider === "gemini") {
    if (!GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set in Netlify environment variables (needed to delegate to Gemini).");
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: task }] }] }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Gemini delegate API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
    }
    const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
      && data.candidates[0].content.parts.map((p) => p.text).join("")) || "";
    return { result: text, provider: "gemini" };
  }

  // Default: Groq (free, same key as the main agent).
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set in Netlify environment variables.");
  }
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_DELEGATE_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: task }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Groq delegate API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  return { result: text, provider: "groq" };
}

// Live web search via Tavily (free tier, no card required).
async function searchWeb({ query }) {
  if (!TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is not set in Netlify environment variables.");
  }
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      max_results: 5,
      include_answer: true,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Tavily search error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  const results = (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: (r.content || "").slice(0, 500),
  }));
  return { answer: data.answer || null, results };
}

// Email the user when a background task finishes (success or error).
// Silently does nothing if RESEND_API_KEY / NOTIFY_EMAIL aren't set — this
// is a nice-to-have, not required for the task itself to work.
async function sendNotificationEmail({ goal, status, answer, error }) {
  if (!RESEND_API_KEY || !NOTIFY_EMAIL) return { skipped: true };
  const subject = status === "error" ? `MKDAI task failed: ${goal.slice(0, 60)}` : `MKDAI task done: ${goal.slice(0, 60)}`;
  const body = status === "error"
    ? `Your MKDAI task failed.\n\nGoal: ${goal}\n\nError: ${error}`
    : `Your MKDAI task finished.\n\nGoal: ${goal}\n\nAnswer:\n${answer}`;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: "MKDAI <onboarding@resend.dev>",
        to: [NOTIFY_EMAIL],
        subject,
        text: body,
      }),
    });
    return { sent: true };
  } catch (err) {
    // Never let a notification failure break the task itself.
    return { sent: false, error: err.message };
  }
}

// Notify the user via WhatsApp (Twilio sandbox) when a task finishes or
// fails — same idea as sendNotificationEmail, just a different channel.
// Silently does nothing if not configured, same as the email version.
async function sendNotificationWhatsApp({ goal, status, answer, error }) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !NOTIFY_WHATSAPP_TO) return { skipped: true };
  const body = status === "error"
    ? `❌ MKDAI task failed.\n\nGoal: ${goal}\n\nError: ${error}`.slice(0, 1500)
    : `✅ MKDAI task done.\n\nGoal: ${goal}\n\nAnswer:\n${answer}`.slice(0, 1500);
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: NOTIFY_WHATSAPP_TO, Body: body }),
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// Sends a real push notification to the browser/PWA when a task finishes —
// uses self-generated VAPID keys (no external service or signup needed).
// Reads the saved subscription from Supabase; silently does nothing if the
// user never enabled push notifications.
async function sendPushNotification(supabase, { goal, status, answer, error }) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { skipped: true };
  const { data: subs } = await supabase.from("mkdai_push_subscriptions").select("subscription").limit(1);
  if (!subs || subs.length === 0) return { skipped: true };

  const webpush = require("web-push");
  webpush.setVapidDetails("mailto:mkdai@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  const title = status === "error" ? "MKDAI task failed" : "MKDAI task done";
  const body = status === "error" ? `${goal.slice(0, 80)} — ${error}`.slice(0, 150) : `${goal.slice(0, 60)}: ${answer}`.slice(0, 150);

  try {
    await webpush.sendNotification(subs[0].subscription, JSON.stringify({ title, body }));
    return { sent: true };
  } catch (err) {
    // Never let a notification failure break the task itself.
    return { sent: false, error: err.message };
  }
}

// Persistent cross-task memory, stored in Supabase (table: mkdai_memory).
// recallMemory is called automatically before every task; saveMemory is a
// tool the agent can call when the user tells it something worth keeping.
async function recallMemory(supabase, limit = 30) {
  const { data, error } = await supabase
    .from("mkdai_memory")
    .select("fact")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data.map((row) => row.fact);
}

async function saveMemory(supabase, { fact }) {
  const { error } = await supabase.from("mkdai_memory").insert({ fact });
  if (error) throw new Error(`Could not save memory: ${error.message}`);
  return { saved: true };
}

// Delete remembered facts that match a substring (case-insensitive).
// Returns what was deleted so the agent can confirm back to the user.
async function forgetMemory(supabase, { query }) {
  const { data: matches, error: findError } = await supabase
    .from("mkdai_memory")
    .select("id, fact")
    .ilike("fact", `%${query}%`);
  if (findError) throw new Error(`Could not search memory: ${findError.message}`);
  if (!matches || matches.length === 0) return { deleted: [] };
  const ids = matches.map((m) => m.id);
  const { error: deleteError } = await supabase.from("mkdai_memory").delete().in("id", ids);
  if (deleteError) throw new Error(`Could not delete memory: ${deleteError.message}`);
  return { deleted: matches.map((m) => m.fact) };
}

// List everything remembered (not just the most recent 30 used in the
// system prompt) — for when the user asks "what do you remember about me?"
async function listAllMemory(supabase) {
  const { data, error } = await supabase
    .from("mkdai_memory")
    .select("fact")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not list memory: ${error.message}`);
  return { facts: (data || []).map((row) => row.fact) };
}

// --- Google Calendar ---
// Uses a one-time OAuth refresh token (not a simple API key — Calendar
// data is private, so Google requires the user to have actually logged in
// and granted access once). Each call exchanges the refresh token for a
// fresh short-lived access token, since access tokens expire hourly and
// there's no persistent process here to cache one safely.
async function getGoogleAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are not all set in Netlify environment variables (needed for Calendar and Drive access).");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google token refresh error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data.access_token;
}

// Run code in a real sandboxed environment via Judge0 (free tier: 50
// executions/day, simple RapidAPI signup, no discretionary approval
// needed). This actually EXECUTES code, unlike everything else MKDAI does
// which only writes/commits it — lets the agent verify its own work.
const JUDGE0_LANGUAGE_IDS = {
  python: 71, python3: 71, py: 71,
  javascript: 63, js: 63, node: 63, nodejs: 63,
  java: 62,
  c: 50,
  cpp: 54, "c++": 54,
  go: 60, golang: 60,
  ruby: 72,
  php: 68,
  bash: 46, shell: 46, sh: 46,
};

async function runCode({ code, language = "python", stdin = "" }) {
  if (!JUDGE0_API_KEY) {
    throw new Error("JUDGE0_API_KEY is not set in Netlify environment variables (needed to run code).");
  }
  const languageId = JUDGE0_LANGUAGE_IDS[String(language).toLowerCase()] || JUDGE0_LANGUAGE_IDS.python;
  const res = await fetch("https://judge0-ce.p.rapidapi.com/submissions?wait=true&base64_encoded=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-RapidAPI-Key": JUDGE0_API_KEY,
      "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
    },
    body: JSON.stringify({ language_id: languageId, source_code: code, stdin }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Code execution API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return {
    stdout: data.stdout || "",
    stderr: data.stderr || "",
    compileOutput: data.compile_output || "",
    status: data.status ? data.status.description : "unknown",
    time: data.time,
    memory: data.memory,
  };
}

// Transcribe an audio file (from a URL) to text using Groq's free Whisper
// endpoint — reuses the same GROQ_API_KEY already set up, no new signup.
async function transcribeAudio({ audioUrl }) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not set in Netlify environment variables.");
  }
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) {
    throw new Error(`Could not download the audio file (${audioRes.status}) from ${audioUrl}`);
  }
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  const form = new FormData();
  form.append("file", new Blob([buffer]), "audio.mp3");
  form.append("model", "whisper-large-v3-turbo");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Groq transcription error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { transcript: data.text || "" };
}

// Fetches a YouTube video's auto-generated captions/transcript — no API
// key needed, just the video's public timed-text track. This is how
// "summarize this YouTube video" actually works: MKDAI reads the real
// transcript text, it doesn't watch the video.
async function getYoutubeTranscript({ url }) {
  const idMatch = url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  const videoId = idMatch ? idMatch[1] : url.trim();
  if (!videoId || videoId.length !== 11) {
    throw new Error("Could not find a valid YouTube video ID in that URL.");
  }
  const { YoutubeTranscript } = require("youtube-transcript");
  const items = await YoutubeTranscript.fetchTranscript(videoId);
  const text = items.map((i) => i.text).join(" ");
  if (!text) {
    throw new Error("No captions/transcript available for this video — it may not have any.");
  }
  return { transcript: text.slice(0, 15000) };
}

// Extracts text from an image (photo of a receipt, document, sign, etc.)
// using Gemini's vision capability — reuses the existing GEMINI_API_KEY,
// no separate OCR service or signup needed.
async function ocrImage({ imageUrl }) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set in Netlify environment variables (needed for OCR).");
  }
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) {
    throw new Error(`Could not download the image (${imgRes.status}) from ${imageUrl}`);
  }
  const buffer = Buffer.from(await imgRes.arrayBuffer());
  const base64 = buffer.toString("base64");
  const contentType = imgRes.headers.get("content-type") || "image/png";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: "Extract all readable text from this image, verbatim, preserving line breaks where meaningful. If there is no readable text, briefly describe the image instead." },
              { inline_data: { mime_type: contentType, data: base64 } },
            ],
          },
        ],
      }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Gemini OCR error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || "").join("");
  return { text: text.slice(0, 8000) };
}

// Generate an image from a text prompt using Pollinations (completely
// free, no signup or API key needed). The generated image is re-uploaded
// to our own Supabase storage so the link stays stable and works the same
// way as screenshots/downloads, rather than depending on an external URL.
async function generateImage(supabase, { prompt, width = 1024, height = 1024 }) {
  const encodedPrompt = encodeURIComponent(prompt);
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Image generation failed (${res.status}).`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const fileName = `generated/${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const { error } = await supabase.storage
    .from("mkdai-files")
    .upload(fileName, buffer, { contentType: "image/png" });
  if (error) throw new Error(`Generated the image but could not save it: ${error.message}`);
  const { data } = supabase.storage.from("mkdai-files").getPublicUrl(fileName);
  return { imageUrl: data.publicUrl, prompt };
}

async function checkCalendar({ timeMin, timeMax, maxResults = 15 }) {
  const accessToken = await getGoogleAccessToken();
  const now = new Date();
  const min = timeMin || now.toISOString();
  const max = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(min)}&timeMax=${encodeURIComponent(max)}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google Calendar API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  const events = (data.items || []).map((e) => ({
    summary: e.summary || "(no title)",
    start: e.start && (e.start.dateTime || e.start.date),
    end: e.end && (e.end.dateTime || e.end.date),
    location: e.location || null,
  }));
  return { events };
}

// Create a new event on the primary calendar.
async function createCalendarEvent({ summary, description, startDateTime, endDateTime, timeZone = "UTC" }) {
  const accessToken = await getGoogleAccessToken();
  const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary,
      description: description || "",
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: endDateTime, timeZone },
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google Calendar API error (${res.status}) creating event: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { eventId: data.id, htmlLink: data.htmlLink, summary: data.summary };
}

// --- Google Drive --- (reuses the same Google login as Calendar above)

async function listDriveFiles({ query, maxResults = 15 }) {
  const accessToken = await getGoogleAccessToken();
  const q = query ? `name contains '${query.replace(/'/g, "\\'")}'` : "";
  const url = `https://www.googleapis.com/drive/v3/files?pageSize=${maxResults}&fields=files(id,name,mimeType,webViewLink,modifiedTime)${q ? `&q=${encodeURIComponent(q)}` : ""}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google Drive API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return {
    files: (data.files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, link: f.webViewLink, modified: f.modifiedTime })),
  };
}

// Reads a file's text content — exports Google Docs/Sheets as plain
// text/CSV, downloads other file types directly.
async function readDriveFile({ fileId }) {
  const accessToken = await getGoogleAccessToken();
  const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meta = await metaRes.json();
  if (!metaRes.ok) {
    throw new Error(`Google Drive API error (${metaRes.status}): ${JSON.stringify(meta).slice(0, 400)}`);
  }

  let url;
  if (meta.mimeType === "application/vnd.google-apps.document") {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
  } else if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`;
  } else {
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive API error (${res.status}): ${errText.slice(0, 400)}`);
  }
  const text = await res.text();
  return { name: meta.name, content: text.slice(0, 15000) };
}

async function uploadDriveFile({ fileName, content, mimeType = "text/plain" }) {
  const accessToken = await getGoogleAccessToken();
  const boundary = `mkdai_boundary_${Date.now()}`;
  const metadata = { name: fileName };
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Google Drive API error (${res.status}) uploading: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return { fileId: data.id, link: data.webViewLink };
}

// Recurring tasks, stored in Supabase (table: mkdai_scheduled_tasks).
// A Netlify Scheduled Function checks this table hourly and runs whatever
// is due, so these keep running even if the app is never opened.
async function scheduleTask(supabase, { goal, frequency }) {
  const freq = ["hourly", "daily", "weekly"].includes(frequency) ? frequency : "daily";
  const { data, error } = await supabase
    .from("mkdai_scheduled_tasks")
    .insert({ goal, frequency: freq })
    .select("id")
    .single();
  if (error) throw new Error(`Could not schedule task: ${error.message}`);
  return { scheduled: true, id: data.id, goal, frequency: freq };
}

async function listScheduledTasks(supabase) {
  const { data, error } = await supabase
    .from("mkdai_scheduled_tasks")
    .select("id, goal, frequency, active, last_run_at")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Could not list scheduled tasks: ${error.message}`);
  return { scheduledTasks: data || [] };
}

// Deactivate (not delete) scheduled tasks whose goal matches a phrase.
async function cancelScheduledTask(supabase, { query }) {
  const { data: matches, error: findError } = await supabase
    .from("mkdai_scheduled_tasks")
    .select("id, goal")
    .eq("active", true)
    .ilike("goal", `%${query}%`);
  if (findError) throw new Error(`Could not search scheduled tasks: ${findError.message}`);
  if (!matches || matches.length === 0) return { cancelled: [] };
  const ids = matches.map((m) => m.id);
  const { error: updateError } = await supabase.from("mkdai_scheduled_tasks").update({ active: false }).in("id", ids);
  if (updateError) throw new Error(`Could not cancel scheduled task: ${updateError.message}`);
  return { cancelled: matches.map((m) => m.goal) };
}

module.exports = {
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
  checkEmail,
  sendEmail,
  aiDelegate,
  searchWeb,
  sendNotificationEmail,
  sendNotificationWhatsApp,
  sendPushNotification,
  recallMemory,
  saveMemory,
  forgetMemory,
  listAllMemory,
  checkCalendar,
  createCalendarEvent,
  listDriveFiles,
  readDriveFile,
  uploadDriveFile,
  generateImage,
  runCode,
  transcribeAudio,
  getYoutubeTranscript,
  ocrImage,
  scheduleTask,
  listScheduledTasks,
  cancelScheduledTask,
};
