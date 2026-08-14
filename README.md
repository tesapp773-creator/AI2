# MKDAI

A personal manager agent: give it a goal in plain English and it decides
what needs to happen — search the live web, read a page, summarize a file,
write to GitHub, open a pull request, trigger a Netlify deploy, or delegate
a hard sub-task to a second, bigger AI model — then reports back with a
clear answer, and emails you when it's done.

## What this v6 does
- **Real manager agent**: Groq (the "brain") decides which tool(s) a goal actually needs and calls them — not just Q&A. If Groq hits a rate limit mid-task, it automatically retries that step on Gemini instead of failing (needs a free Gemini key — see below).
- **Recurring/scheduled tasks**: say "every day", "every hour", or "every week" in a goal and it keeps running automatically — via a Netlify Scheduled Function — even if you never open the app. It can also list or cancel what's scheduled.
- **Email access**: reads/searches your inbox and sends emails on your behalf, both via the same Gmail App Password — can send to any recipient, not just yourself.
- **Live web search**: search_web (Tavily, free tier) for current facts, news, listings — no more guessing from memory.
- **GitHub worker, any repo**: create/update files or open pull requests on ANY repo your token can access — not locked to one. Name a repo in your goal and it'll match it (or list your repos to check spelling). Can also create brand-new repos (requires a classic token — see below).
- **Netlify project creation, fully configured**: create a brand-new Netlify site, optionally linked to a new GitHub repo, and optionally with its own environment variables set — e.g. "create a new repo and Netlify site called my-app, and set GROQ_API_KEY to X on it." When it sets env vars, it triggers a fresh build and actually waits to confirm the deploy succeeded, reporting the real outcome instead of assuming success. It can also check deploy status on any site by ID at any time.
- **Cross-task memory**: it remembers facts you've told it — preferences, recurring details, answers to questions it asked — across separate tasks and days, not just within one job. It can also forget or list what it remembers.
- **Netlify deploy worker**: trigger a new deploy on command for the main site.
- **AI delegate worker**: hand a complex reasoning/coding sub-task to another free AI model and fold its answer back in. Defaults to a bigger Groq model (no extra setup); ask it to use Gemini by name to route there instead (needs a free Gemini key — see below).
- **Read a specific page**: paste a URL in your goal and it fetches that page.
- **Summarize a file**: attach a .txt/.md/.csv/.json/.log file.
- **True background jobs**: tasks run as a Netlify Background Function — you can close the tab and it keeps working.
- **Email notifications**: get an email (via Resend, free tier) when a task finishes or fails.
- **Persistent results**: every task (and which tools it used) is stored in Supabase, visible from any device.

Each worker only activates if its token is configured — if you skip one, MKDAI will tell you plainly which token is missing rather than pretending it did the action.

## 1. Get your API keys / tokens
- **Groq** (required): https://console.groq.com/keys — no card needed.
- **GitHub** (optional, GitHub worker): a **classic token** with `repo` scope, or a fine-grained token with "All repositories" access + Contents/Pull requests read-write (fine-grained can't create new repos).
- **Netlify build hook** (optional, deploy worker for the main site): your Netlify site → Site configuration → Build & deploy → Build hooks → Add build hook.
- **Netlify personal access token** (optional, for creating brand-new sites): Netlify → User settings → Applications → New access token.
- **AI delegate worker**: no extra key needed for Groq — it reuses your `GROQ_API_KEY` from above. For Gemini as a second option, get a free key at https://aistudio.google.com/apikey (no card needed).
- **Tavily** (optional, web search): https://tavily.com — free tier, no card.
- **Resend** (optional, email notifications only — sending emails to others now uses your Gmail login instead, see below): https://resend.com — free tier, no card.
- **Gmail App Password** (optional, reading your inbox): requires 2-Step Verification enabled on your Google account. Go to https://myaccount.google.com/apppasswords, create one for "Mail", copy the 16-character password.

## 2. Supabase (already set up)
This project uses a Supabase project that's already live, with the `mkdai_tasks`, `mkdai_memory`, and `mkdai_scheduled_tasks` tables created:
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
| `GITHUB_TOKEN` | No (enables GitHub worker) | **classic token** with `repo` scope — needed for repo creation; a fine-grained token also works for everything except creating new repos |
| `GITHUB_REPO` | No | `owner/repo` used as the default repo when you don't name one, e.g. `tesapp773-creator/AI2` |
| `NETLIFY_BUILD_HOOK_URL` | No (enables deploy worker for the main site) | from step 1 |
| `NETLIFY_API_TOKEN` | No (enables creating brand-new Netlify sites) | from step 1 |
| `TAVILY_API_KEY` | No (enables web search) | from step 1 |
| `RESEND_API_KEY` | No (enables email notifications + sending) | from step 1 |
| `NOTIFY_EMAIL` | No (needed with Resend key) | the email address to notify |
| `EMAIL_IMAP_USER` | No (enables reading your inbox) | your Gmail address |
| `EMAIL_IMAP_APP_PASSWORD` | No (needed with IMAP user) | the 16-character Gmail App Password from step 1 |
| `GEMINI_API_KEY` | No (enables delegating to Gemini) | from step 1 |
| `GEMINI_MODEL` | No | overrides the default `gemini-3.5-flash` |

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

