// netlify/functions/scheduled-runner.js
//
// Netlify Scheduled Function — runs automatically on the cron schedule set
// in netlify.toml (currently hourly), with no user interaction needed.
// Checks mkdai_scheduled_tasks for anything due, runs it through the same
// manager loop as an on-demand task, and updates last_run_at.
//
// "Due" logic:
//   hourly  -> always due (runner itself runs hourly)
//   daily   -> due if never run, or last run was 23+ hours ago
//   weekly  -> due if never run, or last run was 6.5+ days ago

const { schedule } = require("@netlify/functions");
const { getClient } = require("./_supabase");
const { runTask } = require("./_run_task");

const HOUR_MS = 60 * 60 * 1000;

function isDue(task, now) {
  if (!task.last_run_at) return true;
  const elapsed = now - new Date(task.last_run_at).getTime();
  if (task.frequency === "hourly") return elapsed >= HOUR_MS - 5 * 60 * 1000; // small buffer
  if (task.frequency === "daily") return elapsed >= 23 * HOUR_MS;
  if (task.frequency === "weekly") return elapsed >= 6.5 * 24 * HOUR_MS;
  return false;
}

async function runDueTasks() {
  const supabase = getClient();
  const { data: tasks, error } = await supabase
    .from("mkdai_scheduled_tasks")
    .select("id, goal, frequency, last_run_at")
    .eq("active", true);

  if (error) {
    console.error("Could not load scheduled tasks:", error.message);
    return;
  }

  const now = Date.now();
  const due = (tasks || []).filter((t) => isDue(t, now));

  for (const task of due) {
    try {
      await runTask(supabase, { goal: task.goal, fileText: "" });
    } catch (err) {
      console.error(`Scheduled task ${task.id} failed:`, err.message);
      // runTask already records the error on the mkdai_tasks row and emails
      // the user, so nothing further to do here.
    }
    await supabase
      .from("mkdai_scheduled_tasks")
      .update({ last_run_at: new Date().toISOString() })
      .eq("id", task.id);
  }
}

exports.handler = schedule("@hourly", async () => {
  await runDueTasks();
  return { statusCode: 200 };
});
