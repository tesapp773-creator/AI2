# MKDAI

A personal manager agent: give it a goal in plain English and it decides
what needs to happen — search the live web, read a page, summarize a file,
write to GitHub, open a pull request, trigger a Netlify deploy, or delegate
a hard sub-task to a second, bigger AI model — then reports back with a
clear answer, and emails you when it's done.

## What this v4 does
- **Real manager agent**: Groq (the "brain") decides which tool(s) a goal actually needs and calls them — not just Q&A.
- **Live web search**: search_web (Tavily, free tier) for current facts, news, listings — no more guessing from memory.
- **GitHub worker, any repo**: create/update files or open pull requests on ANY repo your token can access — not locked to one. Name a repo in your goal and it'll match it (or list your repos to check spelling).
- **Cross-task memory**: it remembers facts you've told it — preferences, recurring details, answers to questions it asked — across separate tasks and days, not just within one job.
- **Netlify deploy worker**: trigger a new deploy on command.
- **AI delegate worker**: hand a complex reasoning/coding sub-task to a bigger Groq model (free, same key as the main agent) and fold its answer back in.
- **Read a specific page**: paste a URL in your goal and it fetches that page.
- **Summarize a file**: attach a .txt/.md/.csv/.json/.log file.
- **True background jobs**: tasks run as a Netlify Background Function — you can close the tab and it keeps working.
- **Email notifications**: get an email (via Resend, free tier) when a task finishes or fails.
- **Persistent results**: every task (and which tools it used) is stored in Supabase, visible from any device.

Each worker only activates if its token is configured — if you skip one, MKDAI will tell you plainly which token is missing rather than pretending it did the action.

## 1. Get your API keys / tokens
- **Groq** (required): https://console.groq.com/keys — no card needed.
- **GitHub** (optional, GitHub worker): a fine-grained personal access token scoped to the target repo, with **Contents: Read and write** and **Pull requests: Read and write** permissions. github.com → Settings → Developer settings → Fine-grained tokens.
- **Netlify build hook** (optional, deploy worker): your Netlify site → Site configuration → Build & deploy → Build hooks → Add build hook. Copy the URL (different from a personal access token).
- **AI delegate worker**: no extra key needed — it reuses your `GROQ_API_KEY` from above, just calls a bigger free model.
- **Tavily** (optional, web search): https://tavily.com — free tier, no card.
- **Resend** (optional, email notifications): https://resend.com — free tier, no card. Note: the default sender (`onboarding@resend.dev`) can only send to the email address you signed up to Resend with, unless you verify your own domain.

## 2. Supabase (already set up)
This project uses a Supabase project that's already live, with the `mkdai_tasks` table created:
- Project URL: `https://flipqcruvtujomcunhet.supabase.co`
- You'll add the URL + anon key as environment variables in Netlify (step 4).

## 3. Push this to GitHub
```bash
git add -A
git commit -m "Update MKDAI"
git push
```

## 4. Deploy on Netlify
Site configuration → Environment variables → add whichever of these you want active:

| Key | Required? | Value |
|---|---|---|
| `GROQ_API_KEY` | Yes | from step 1 |
| `SUPABASE_URL` | Yes | `https://flipqcruvtujomcunhet.supabase.co` |
| `SUPABASE_ANON_KEY` | Yes | Supabase dashboard → project → Settings → API → `anon` `public` key |
| `GROQ_MODEL` | No | overrides the default `openai/gpt-oss-120b` |
| `GROQ_DELEGATE_MODEL` | No | overrides the default `llama-3.3-70b-versatile` used by the AI delegate worker |
| `GITHUB_TOKEN` | No (enables GitHub worker) | your fine-grained PAT — set "Repository access" to **All repositories** so it can work on any repo, not just one |
| `GITHUB_REPO` | No | `owner/repo` used as the default repo when you don't name one, e.g. `tesapp773-creator/AI2` |
| `NETLIFY_BUILD_HOOK_URL` | No (enables deploy worker) | from step 1 |
| `TAVILY_API_KEY` | No (enables web search) | from step 1 |
| `RESEND_API_KEY` | No (enables email notifications) | from step 1 |
| `NOTIFY_EMAIL` | No (needed with Resend key) | the email address to notify |

Then Deploys tab → Trigger deploy → Deploy site.

## 5. Use it
Open your Netlify site URL, type a goal, hit Run. The task now runs in the
background — the page will poll and update automatically, but you can also
close the tab and check back later, or wait for the email. Try something
concrete like: "Create a file called notes.md in the repo with today's date
and commit it" to see the GitHub worker in action, or "search the web for
today's top tech news" to see live search.

## Extending it later
- Add more workers by adding a new function + tool entry in `netlify/functions/_tools.js` and `netlify/functions/agent-background.js`.

