// netlify/functions/agent-background.js
//
// MKDAI manager function (runs as a Netlify Background Function — keeps
// working even if the user closes the tab). Receives a goal from the app
// and runs it through the shared manager loop in _run_task.js.
//
// Env vars (Netlify > Site configuration > Environment variables):
//   GROQ_API_KEY            - required, powers the manager's reasoning AND the delegate worker
//   GROQ_MODEL              - optional, defaults to "openai/gpt-oss-120b"
//   GROQ_DELEGATE_MODEL     - optional, defaults to "llama-3.3-70b-versatile"
//   SUPABASE_URL / SUPABASE_ANON_KEY - required, task history + memory + schedules
//   GITHUB_TOKEN            - optional, enables the GitHub worker. Classic token
//                             (repo scope) needed for repo creation; fine-grained
//                             with "All repositories" access works for everything else.
//   GITHUB_REPO             - optional, default "owner/repo" used when the user
//                             doesn't name a specific repo
//   NETLIFY_BUILD_HOOK_URL  - optional, enables the Netlify deploy worker
//   TAVILY_API_KEY          - optional, enables live web search
//   RESEND_API_KEY / NOTIFY_EMAIL - optional, enables email notifications

const { getClient } = require("./_supabase");
const { runTask } = require("./_run_task");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const goal = (payload.goal || "").trim();
  const fileText = (payload.fileText || "").trim();
  const conversationId = payload.conversationId || null;
  if (!goal) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'goal'" }) };
  }

  try {
    const supabase = getClient();
    const result = await runTask(supabase, { goal, fileText, conversationId });
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
