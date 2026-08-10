# MKDAI

A personal AI agent: give it a goal in plain English and it searches the web,
reads a page you link, or summarizes a file you attach — then shows you a
clear answer with sources.

## What this v1 does
- **Web research**: ask it anything and it uses Google Search grounding (via Gemini) to find current info.
- **Read a specific page**: paste a URL in your goal ("summarize https://...") and it fetches that page first.
- **Summarize a file**: attach a .txt/.md/.csv/.json/.log file and ask it to summarize or extract from it.
- **Persistent results**: every result is saved in your browser, so closing and reopening the app still shows past results.

## What v1 does *not* do yet
- True "close the app, come back later, get notified" background jobs — Netlify's free functions run for a bounded time per request, so tasks run while the page is open. This is a clean place to add a job queue + email notification later if you want it.

## 1. Get a Gemini API key
Go to https://aistudio.google.com/apikey and create a key.

## 2. Push this to GitHub
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

## 3. Deploy on Netlify
1. Netlify dashboard → "Add new site" → "Import an existing project" → pick this repo.
2. Build settings: leave as detected (publish directory `public`, functions directory `netlify/functions`) — already set in `netlify.toml`.
3. Site configuration → Environment variables → add:
   - `GEMINI_API_KEY` = your key from step 1
   - (optional) `GEMINI_MODEL` = a specific Gemini model name, if you want to override the default
4. Deploy.

## 4. Use it
Open your Netlify site URL, type a goal, hit Run.

## Extending it later
- Add more "workers" by adding logic to `netlify/functions/agent.js` (e.g. a dedicated jobs-search worker that queries a jobs API).
- For true background jobs + notifications: add a small database (Netlify Blobs or a free Supabase project) to store task state, and an email step (e.g. Resend's free tier) to notify when a long task finishes.
