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
    body: JSON.stringify({ name, description: description || "", private: isPrivate }),
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

module.exports = {
  githubWriteFile,
  githubCreatePullRequest,
  githubListRepos,
  githubCreateRepo,
  netlifyDeploy,
  aiDelegate,
  searchWeb,
  sendNotificationEmail,
  recallMemory,
  saveMemory,
  forgetMemory,
  listAllMemory,
};
