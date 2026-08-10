# MKDAI

A personal AI agent: give it a goal in plain English and it searches the web,
reads a page you link, or summarizes a file you attach — then shows you a
clear answer with sources.

## What this v1 does
- **Reasoning/summarizing**: runs on Groq (free, fast, no billing card required) to answer, research from context, and summarize.
- **Read a specific page**: paste a URL in your goal ("summarize https://...") and it fetches that page first, then summarizes/answers using its actual content.
- **Summarize a file**: attach a .txt/.md/.csv/.json/.log file and ask it to summarize or extract from it.
- **Persistent results (real database)**: every task is stored in a Supabase Postgres table (`mkdai_tasks`), so results show up on any device you open the app from — not just the browser you ran it in.

## What v1 does *not* do yet
- **Live web search**: Groq's free models don't have built-in search grounding like Gemini does, so open-ended "search the web for X" goals rely on the model's own training knowledge, not live results — it will say so when it's unsure. Adding real search (e.g. via Tavily's free tier, built for exactly this) is a clean next step.
- **True background jobs + notifications**: Netlify's free functions run for a bounded time per request, so tasks run while the page is open. The database is already in place for this, though — adding a queue + email/push notification step later is a natural next step, not a rebuild.

## 1. Get a Groq API key
Go to https://console.groq.com/keys and create a key. No credit card required, free tier included.

## 2. Supabase (already set up)
This project uses a Supabase project that's already live, with the `mkdai_tasks` table created:
- Project URL: `https://flipqcruvtujomcunhet.supabase.co`
- Table: `mkdai_tasks` (goal, status, answer, sources, steps, error, timestamps)
- You'll add the URL + anon key as environment variables in Netlify (step 3) — no setup needed on your end.

## 3. Push this to GitHub
From this folder:
```bash
git add -A
git commit -m "Initial commit: MKDAI v1"
```
Then create a new empty repo on GitHub (github.com/new — don't add a README there), and:
```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## 4. Deploy on Netlify
1. Netlify dashboard → "Add new site" → "Import an existing project" → pick this repo.
2. Build settings: leave as detected (publish directory `public`, functions directory `netlify/functions`) — already set in `netlify.toml`.
3. Site configuration → Environment variables → add:
   - `GROQ_API_KEY` = your key from step 1
   - `SUPABASE_URL` = `https://flipqcruvtujomcunhet.supabase.co`
   - `SUPABASE_ANON_KEY` = the anon/publishable key (see below)
   - (optional) `GROQ_MODEL` = a specific Groq model name, if you want to override the default (`openai/gpt-oss-120b`)
4. Deploy.

To get the Supabase anon key: Supabase dashboard → your project → Settings → API → copy the `anon` `public` key.

## 5. Use it
Open your Netlify site URL, type a goal, hit Run.

## Extending it later
- Add more "workers" by adding logic to `netlify/functions/agent.js` (e.g. a dedicated jobs-search worker that queries a jobs API).
- For true background jobs + notifications: add a small database (Netlify Blobs or a free Supabase project) to store task state, and an email step (e.g. Resend's free tier) to notify when a long task finishes.
