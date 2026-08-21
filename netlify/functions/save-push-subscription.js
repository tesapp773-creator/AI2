// netlify/functions/save-push-subscription.js
//
// Stores the browser's push subscription so runTask can send a real push
// notification when a task finishes. Only one subscription is kept (this
// is a single-user app) — a new one replaces the old.

const { getClient } = require("./_supabase");

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

  if (!payload.subscription) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'subscription'" }) };
  }

  try {
    const supabase = getClient();
    // Single-user app — clear any old subscription(s) first, then save the new one.
    await supabase.from("mkdai_push_subscriptions").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    const { error } = await supabase.from("mkdai_push_subscriptions").insert({ subscription: payload.subscription });
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ saved: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
