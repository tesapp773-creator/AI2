// netlify/functions/dashboard.js
//
// Read-only status + stats for the Dashboard tab. Never exposes actual key
// values — only whether each integration is configured (a boolean) — and
// pulls quick usage stats from Supabase. This can't let the user edit env
// vars from the browser (that would mean exposing a token with write
// access to Netlify's API to client-side JS, which is a real security
// hole), so it's status + stats only; changes still happen in Netlify.

const { getClient } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const has = (...names) => names.every((n) => !!process.env[n]);

  const integrations = {
    "Groq (brain)": has("GROQ_API_KEY"),
    "Gemini fallback": has("GEMINI_API_KEY"),
    "Web search": has("TAVILY_API_KEY"),
    "GitHub": has("GITHUB_TOKEN"),
    "Netlify deploy": has("NETLIFY_BUILD_HOOK_URL"),
    "Netlify site creation": has("NETLIFY_API_TOKEN"),
    "Email (read/send)": has("EMAIL_IMAP_USER", "EMAIL_IMAP_APP_PASSWORD"),
    "Email notifications": has("RESEND_API_KEY", "NOTIFY_EMAIL"),
    "Google Calendar": has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"),
    "WhatsApp notifications": has("TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "NOTIFY_WHATSAPP_TO"),
  };

  const backupKeys = {
    groq: [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean).length,
    gemini: [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3].filter(Boolean).length,
  };

  try {
    const supabase = getClient();
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const [tasksToday, totalTasks, scheduled, memory, conversations] = await Promise.all([
      supabase.from("mkdai_tasks").select("id", { count: "exact", head: true }).gte("created_at", todayStart.toISOString()),
      supabase.from("mkdai_tasks").select("id", { count: "exact", head: true }),
      supabase.from("mkdai_scheduled_tasks").select("id", { count: "exact", head: true }).eq("active", true),
      supabase.from("mkdai_memory").select("id", { count: "exact", head: true }),
      supabase.from("mkdai_conversations").select("id", { count: "exact", head: true }),
    ]);

    const stats = {
      tasksToday: tasksToday.count || 0,
      totalTasks: totalTasks.count || 0,
      activeScheduled: scheduled.count || 0,
      memoryFacts: memory.count || 0,
      conversations: conversations.count || 0,
    };

    return { statusCode: 200, body: JSON.stringify({ integrations, backupKeys, stats }) };
  } catch (err) {
    return { statusCode: 200, body: JSON.stringify({ integrations, backupKeys, stats: null, statsError: err.message }) };
  }
};
