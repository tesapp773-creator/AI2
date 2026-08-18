// netlify/functions/tasks.js
const { getClient } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const supabase = getClient();
    const conversationId = event.queryStringParameters && event.queryStringParameters.conversationId;
    let query = supabase
      .from("mkdai_tasks")
      .select("id, goal, status, answer, sources, error, steps, tool_count, tools_used, conversation_id, created_at")
      .order("created_at", { ascending: false })
      .limit(conversationId ? 200 : 50);
    if (conversationId) {
      query = query.eq("conversation_id", conversationId);
    }
    const { data, error } = await query;
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ tasks: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
