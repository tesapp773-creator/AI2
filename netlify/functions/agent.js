// netlify/functions/agent.js
//
// MKDAI manager function.
// Receives a goal, then runs a manager loop: Groq (the "brain") decides
// which worker tool(s) to call — write/PR to GitHub, trigger a Netlify
// deploy, delegate a sub-task to a bigger AI model, or fetch a web page —
// executes them, feeds results back, and repeats until it has a final answer.
//
// Env vars (Netlify > Site configuration > Environment variables):
//   GROQ_API_KEY            - required, powers the manager's reasoning AND the delegate worker
//   GROQ_MODEL              - optional, defaults to "openai/gpt-oss-120b"
//   GROQ_DELEGATE_MODEL     - optional, defaults to "llama-3.3-70b-versatile"
//   SUPABASE_URL / SUPABASE_ANON_KEY - required, task history
//   GITHUB_TOKEN            - optional, enables the GitHub worker
//   GITHUB_REPO             - optional, "owner/repo" the GitHub worker acts on
//   NETLIFY_BUILD_HOOK_URL  - optional, enables the Netlify deploy worker

const { getClient } = require("./_supabase");
const { githubWriteFile, githubCreatePullRequest, netlifyDeploy, aiDelegate } = require("./_tools");

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const API_KEY = process.env.GROQ_API_KEY;
const MAX_TURNS = 6;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch a web page and return its readable text content.",
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
      name: "github_write_file",
      description: "Create or update a single file directly on the main branch of the configured GitHub repo.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path in the repo, e.g. src/index.js" },
          content: { type: "string", description: "Full new file content." },
          message: { type: "string", description: "Commit message." },
        },
        required: ["path", "content", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "github_create_pull_request",
      description: "Create a new branch with one or more file changes and open a pull request. Use this instead of github_write_file when the change should be reviewed before merging.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
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
      name: "netlify_deploy",
      description: "Trigger a new Netlify deploy for the configured site.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "ai_delegate",
      description: "Delegate a complex reasoning, writing, or coding sub-task to a bigger AI model and get back its answer.",
      parameters: {
        type: "object",
        properties: { task: { type: "string", description: "The sub-task/prompt to send." } },
        required: ["task"],
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

async function runTool(name, args, steps) {
  try {
    switch (name) {
      case "fetch_url": {
        steps.push(`Fetching ${args.url} ...`);
        return await fetchPageText(args.url);
      }
      case "github_write_file": {
        steps.push(`Writing ${args.path} to GitHub...`);
        return await githubWriteFile(args);
      }
      case "github_create_pull_request": {
        steps.push(`Opening a pull request: ${args.title}`);
        return await githubCreatePullRequest(args);
      }
      case "netlify_deploy": {
        steps.push("Triggering a Netlify deploy...");
        return await netlifyDeploy();
      }
      case "ai_delegate": {
        steps.push("Delegating a sub-task to a bigger AI model...");
        return await aiDelegate(args);
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    steps.push(`${name} failed: ${err.message}`);
    return { error: err.message };
  }
}

async function callGroq(messages) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API error (${res.status}): ${errText.slice(0, 500)}`);
  }
  const data = await res.json();
  return data.choices[0].message;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  if (!API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "GROQ_API_KEY is not set on the server. Add it in Netlify > Site configuration > Environment variables, then redeploy.",
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
    const { data, error } = await supabase.from("mkdai_tasks").insert({ goal, status: "running" }).select("id").single();
    if (error) throw error;
    taskId = data.id;
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Database error: ${err.message}` }) };
  }

  const steps = [];
  const systemPrompt = `You are MKDAI, a personal manager agent. You have real tools: fetch_url (read a web page), github_write_file / github_create_pull_request (act on the user's GitHub repo), netlify_deploy (trigger a deploy), and ai_delegate (hand a sub-task to a bigger AI model for deeper reasoning or coding). Use tools when the user's goal actually requires an action or current information you don't have. When a tool isn't configured (missing token) it will return an error — tell the user plainly which token is missing rather than pretending you did the action. Once you have everything you need, reply with a clear, concrete final answer and no further tool calls. You do not have live web search beyond fetch_url on a specific page, so don't invent current facts (like today's job listings) you can't verify.`;

  const userContent = fileText
    ? `${goal}\n\nAttached file content:\n${fileText.slice(0, 12000)}`
    : goal;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userContent },
  ];

  try {
    let finalAnswer = null;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const message = await callGroq(messages);
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
        const result = await runTool(call.function.name, args, steps);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 4000),
        });
      }
    }

    if (finalAnswer === null) {
      finalAnswer = "I ran out of steps working on this — try breaking the goal into a smaller request.";
    }

    steps.push("Done.");
    await supabase
      .from("mkdai_tasks")
      .update({ status: "done", answer: finalAnswer, sources: [], steps, updated_at: new Date().toISOString() })
      .eq("id", taskId);

    return { statusCode: 200, body: JSON.stringify({ id: taskId, answer: finalAnswer, sources: [], steps }) };
  } catch (err) {
    await supabase
      .from("mkdai_tasks")
      .update({ status: "error", error: err.message, steps, updated_at: new Date().toISOString() })
      .eq("id", taskId);
    return { statusCode: 500, body: JSON.stringify({ id: taskId, error: err.message, steps }) };
  }
};
