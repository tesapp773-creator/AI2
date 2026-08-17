// netlify/functions/cancel-task.js
//
// Sets cancel_requested on a task so the running background function
// notices it between turns and stops itself cleanly. This can't force-kill
// a background function from outside — it's a cooperative "please stop",
// checked once per turn, so it may take a few seconds after clicking Stop.

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

  const taskId = payload.taskId;
  if (!taskId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'taskId'" }) };
  }

  try {
    const supabase = getClient();
    const { error } = await supabase
      .from("mkdai_tasks")
      .update({ cancel_requested: true })
      .eq("id", taskId)
      .eq("status", "running");
    if (error) throw error;
    return { statusCode: 200, body: JSON.stringify({ cancelRequested: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
