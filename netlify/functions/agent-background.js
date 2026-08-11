// netlify/functions/agent-background.js
//
// MKDAI manager function (runs as a Netlify Background Function — keeps
// working even if the user closes the tab).
// Receives a goal, then runs a manager loop: Groq (the "brain") decides
// which worker tool(s) to call — write/PR to any GitHub repo the token can
// access, trigger a Netlify deploy, delegate a sub-task to a bigger AI
// model, search the live web, fetch a specific web page, or remember a
// fact for future tasks — executes them, feeds results back, and repeats
// until it has a final answer. Emails the user (via Resend) when done.
//
// Env vars (Netlify > Site configuration > Environment variables):
//   GROQ_API_KEY            - required, powers the manager's reasoning AND the delegate worker
//   GROQ_MODEL              - optional, defaults to "openai/gpt-oss-120b"
//   GROQ_DELEGATE_MODEL     - optional, defaults to "llama-3.3-70b-versatile"
//   SUPABASE_URL / SUPABASE_ANON_KEY - required, task history + memory
//   GITHUB_TOKEN            - optional, enables the GitHub worker. For multi-repo
//                             support, generate it with "All repositories" access.
//   GITHUB_REPO             - optional, default "owner/repo" used when the user
//                             doesn't name a specific repo
//   NETLIFY_BUILD_HOOK_URL  - optional, enables the Netlify deploy worker
//   TAVILY_API_KEY          - optional, enables live web search
//   RESEND_API_KEY / NOTIFY_EMAIL - optional, enables email notifications

const { getClient } = require("./_supabase");
const {
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
} = require("./_tools");

const MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const API_KEY = process.env.GROQ_API_KEY;
const MAX_TURNS = 6;

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

async function runTool(name, args, steps, supabase) {
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
      case "github_list_repos": {
        steps.push("Listing your GitHub repos...");
        return await githubListRepos();
      }
      case "github_create_repo": {
        steps.push(`Creating a new GitHub repo: ${args.name}...`);
        return await githubCreateRepo(args);
      }
      case "github_write_file": {
        steps.push(`Writing ${args.path} to ${args.repo || "the default repo"}...`);
        return await githubWriteFile(args);
      }
      case "github_create_pull_request": {
        steps.push(`Opening a pull request on ${args.repo || "the default repo"}: ${args.title}`);
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
  const memoryFacts = await recallMemory(supabase);
  const memorySection = memoryFacts.length
    ? `\n\nThings you already know about the user from past tasks (use these, don't ask again if already answered here):\n- ${memoryFacts.join("\n- ")}`
    : "";
  const systemPrompt = `You are MKDAI, a personal manager agent. You have real tools: search_web (search the live web for current info), fetch_url (read a specific web page), github_list_repos (list the user's repos), github_create_repo (create a brand-new repo), github_write_file / github_create_pull_request (act on ANY of the user's GitHub repos — pass 'repo' as "owner/repo" when the user names one, using github_list_repos first if you're not sure of the exact spelling), netlify_deploy (trigger a deploy), ai_delegate (hand a sub-task to a bigger AI model for deeper reasoning or coding), and save_memory (remember a durable fact for future tasks — use it whenever the user tells you a preference, a recurring detail, or answers a question you asked), forget_memory (delete a remembered fact matching a word/phrase — use it when the user says to forget or correct something), and list_memory (show everything currently remembered, e.g. when the user asks what you remember about them). Use tools when the user's goal actually requires an action or current information you don't have — prefer search_web for anything current (news, listings, facts) rather than guessing from memory. When a tool isn't configured (missing token) it will return an error — tell the user plainly which token is missing rather than pretending you did the action. Once you have everything you need, reply with a clear, concrete final answer and no further tool calls.${memorySection}`;

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
        const result = await runTool(call.function.name, args, steps, supabase);
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
    await sendNotificationEmail({ goal, status: "done", answer: finalAnswer });

    return { statusCode: 200, body: JSON.stringify({ id: taskId, answer: finalAnswer, sources: [], steps }) };
  } catch (err) {
    await supabase
      .from("mkdai_tasks")
      .update({ status: "error", error: err.message, steps, updated_at: new Date().toISOString() })
      .eq("id", taskId);
    await sendNotificationEmail({ goal, status: "error", error: err.message });
    return { statusCode: 500, body: JSON.stringify({ id: taskId, error: err.message, steps }) };
  }
};
