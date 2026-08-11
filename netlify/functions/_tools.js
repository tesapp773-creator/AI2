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

function b64(str) {
  return Buffer.from(str, "utf-8").toString("base64");
}

async function ghFetch(path, options = {}) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error("GITHUB_TOKEN and/or GITHUB_REPO is not set in Netlify environment variables.");
  }
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}${path}`, {
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
    throw new Error(`GitHub API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  return data;
}

// Create or update a single file directly on a branch (default: main).
async function githubWriteFile({ path, content, message, branch = "main" }) {
  let sha;
  try {
    const existing = await ghFetch(`/contents/${encodeURIComponent(path)}?ref=${branch}`);
    sha = existing.sha;
  } catch {
    // File doesn't exist yet — that's fine, we're creating it.
  }
  const body = { message, content: b64(content), branch };
  if (sha) body.sha = sha;
  const result = await ghFetch(`/contents/${encodeURIComponent(path)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  return { path, commitUrl: result.commit && result.commit.html_url };
}

// Create a new branch off `base`, write one or more files to it, open a PR.
async function githubCreatePullRequest({ title, body, files, base = "main", branch }) {
  const branchName = branch || `mkdai-${Date.now()}`;
  const baseRef = await ghFetch(`/git/ref/heads/${base}`);
  const baseSha = baseRef.object.sha;
  await ghFetch(`/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: baseSha }),
  });
  for (const f of files) {
    await githubWriteFile({ path: f.path, content: f.content, message: title, branch: branchName });
  }
  const pr = await ghFetch(`/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body: body || "", head: branchName, base }),
  });
  return { prUrl: pr.html_url, branch: branchName };
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

// Delegate a sub-task to a bigger Groq model for deeper reasoning/coding help.
// Reuses the same free GROQ_API_KEY as the main agent — no separate key needed.
async function aiDelegate({ task }) {
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
  return { result: text };
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

module.exports = { githubWriteFile, githubCreatePullRequest, netlifyDeploy, aiDelegate, searchWeb, sendNotificationEmail };
