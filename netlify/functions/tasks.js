// netlify/functions/tasks.js
const { getClient } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from("mkdai_tasks")
      .select("id, goal, status, answer, sources, error, created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ tasks: data }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
