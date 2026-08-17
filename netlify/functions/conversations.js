// netlify/functions/conversations.js
//
// Lists conversation threads for the sidebar, most recently active first.

const { getClient } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("mkdai_conversations")
      .select("id, title, created_at, updated_at")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ conversations: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
