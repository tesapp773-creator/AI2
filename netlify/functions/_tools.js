// netlify/functions/_tools.js
//
// Real "worker" actions the manager can call. Each one requires its own
// token, read from environment variables set in Netlify (never hardcoded,
// never sent from the browser).

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // "owner/repo"
const NETLIFY_BUILD_HOOK_URL = process.env.NETLIFY_BUILD_HOOK_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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

// Delegate a sub-task to Claude for deeper reasoning/coding help.
async function claudeDelegate({ task }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in Netlify environment variables.");
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: task }],
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Claude API error (${res.status}): ${JSON.stringify(data).slice(0, 400)}`);
  }
  const text = (data.content || []).map((b) => b.text || "").join("\n");
  return { result: text };
}

module.exports = { githubWriteFile, githubCreatePullRequest, netlifyDeploy, claudeDelegate };
