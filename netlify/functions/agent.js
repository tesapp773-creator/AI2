// netlify/functions/agent.js
//
// MKDAI manager function.
// Receives a goal from the user (and optionally file text the user attached),
// pulls in web context if useful, then asks Gemini to do the actual work
// (answer, research, summarize) and hands back a result + any sources used.
//
// Env vars required (set these in Netlify > Site configuration > Environment variables):
//   GEMINI_API_KEY   - your Gemini API key
//   GEMINI_MODEL     - optional, defaults to "gemini-2.5-flash"

const { getClient } = require("./_supabase");

const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const API_KEY = process.env.GEMINI_API_KEY;

// Pull the first http(s) URL out of a string, if any.
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s)]+/i);
  return match ? match[0] : null;
}

// Fetch a URL and strip it down to readable text (best-effort, no external deps).
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
    // Keep it bounded so we don't blow the model's context or the function's time budget.
    return { text: text.slice(0, 15000) };
  } catch (err) {
    clearTimeout(timeout);
    return { error: `Could not fetch that page (${err.message})` };
  }
}

async function callGemini({ prompt, useSearch }) {
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  };
  if (useSearch) {
    body.tools = [{ google_search: {} }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 500)}`);
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const answer =
    (candidate &&
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts.map((p) => p.text || "").join("\n")) ||
    "(no response)";

  // Pull out grounding sources if Gemini used search.
  let sources = [];
  const grounding = candidate && candidate.groundingMetadata;
  if (grounding && grounding.groundingChunks) {
    sources = grounding.groundingChunks
      .map((c) => c.web && { title: c.web.title, url: c.web.uri })
      .filter(Boolean);
  }

  return { answer, sources };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error:
          "GEMINI_API_KEY is not set on the server. Add it in Netlify > Site configuration > Environment variables, then redeploy.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const goal = (payload.goal || "").trim();
  const fileText = (payload.fileText || "").trim();
  if (!goal) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'goal'" }) };
  }

  let supabase;
  let taskId;
  try {
    supabase = getClient();
    const { data, error } = await supabase
      .from("mkdai_tasks")
      .insert({ goal, status: "running" })
      .select("id")
      .single();
    if (error) throw error;
    taskId = data.id;
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Database error: ${err.message}` }) };
  }

  const steps = [];
  let context = "";

  // Worker 1: if the goal contains a URL, fetch that page first.
  const url = extractUrl(goal);
  if (url) {
    steps.push(`Fetching ${url} ...`);
    const page = await fetchPageText(url);
    if (page.error) {
      steps.push(`Could not fetch the page: ${page.error}`);
    } else {
      steps.push("Page fetched. Reading it now.");
      context += `\n\nContent fetched from ${url}:\n${page.text}\n`;
    }
  }

  // Worker 2: any file text the user attached.
  if (fileText) {
    steps.push("Reading attached file content.");
    context += `\n\nContent from the user's attached file:\n${fileText.slice(0, 15000)}\n`;
  }

  // Decide whether Gemini should also search the web itself:
  // - always useful for open-ended research/job-search style goals
  // - skip only when we already fetched a specific page and the goal is just "summarize this"
  const useSearch = true;

  const prompt = `You are MKDAI, a helpful personal research and task assistant.
The user's goal:
"""${goal}"""
${context ? `\nUse the following extra context if relevant:${context}` : ""}

Give a clear, concrete, well-organized answer. If you are unsure or the information may be outdated, say so plainly. If sources were used, they will be listed separately, so do not fabricate citations yourself.`;

  steps.push("Thinking and gathering the answer...");

  try {
    const { answer, sources } = await callGemini({ prompt, useSearch });
    steps.push("Done.");
    await supabase
      .from("mkdai_tasks")
      .update({ status: "done", answer, sources, steps, updated_at: new Date().toISOString() })
      .eq("id", taskId);
    return {
      statusCode: 200,
      body: JSON.stringify({ id: taskId, answer, sources, steps }),
    };
  } catch (err) {
    await supabase
      .from("mkdai_tasks")
      .update({ status: "error", error: err.message, steps, updated_at: new Date().toISOString() })
      .eq("id", taskId);
    return {
      statusCode: 500,
      body: JSON.stringify({ id: taskId, error: err.message, steps }),
    };
  }
};
