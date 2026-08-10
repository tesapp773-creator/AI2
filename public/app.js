const goalInput = document.getElementById("goalInput");
const fileInput = document.getElementById("fileInput");
const fileNameEl = document.getElementById("fileName");
const runBtn = document.getElementById("runBtn");
const statusEl = document.getElementById("status");
const stepsList = document.getElementById("stepsList");
const resultsList = document.getElementById("resultsList");

let attachedFileText = "";

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) {
    fileNameEl.textContent = "";
    attachedFileText = "";
    return;
  }
  fileNameEl.textContent = file.name;
  attachedFileText = await file.text();
});

async function fetchResults() {
  try {
    const res = await fetch("/api/tasks");
    const data = await res.json();
    return data.tasks || [];
  } catch {
    return [];
  }
}

async function renderResults() {
  const results = await fetchResults();
  resultsList.innerHTML = "";
  if (results.length === 0) {
    resultsList.innerHTML = '<p style="color:var(--muted); font-size:13px;">Nothing yet — run a task above.</p>';
    return;
  }
  for (const r of results) {
    const card = document.createElement("div");
    const isError = r.status === "error";
    card.className = "result-card" + (isError ? " error" : "");

    const goalEl = document.createElement("div");
    goalEl.className = "goal";
    goalEl.textContent = r.goal;
    card.appendChild(goalEl);

    const answerEl = document.createElement("div");
    answerEl.className = "answer";
    if (isError) {
      answerEl.textContent = `Error: ${r.error}`;
    } else if (r.status === "running" || r.status === "pending") {
      answerEl.textContent = "Still working...";
    } else {
      answerEl.textContent = r.answer;
    }
    card.appendChild(answerEl);

    if (r.sources && r.sources.length) {
      const srcEl = document.createElement("div");
      srcEl.className = "sources";
      srcEl.innerHTML = "Sources:";
      for (const s of r.sources) {
        const a = document.createElement("a");
        a.href = s.url;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = s.title || s.url;
        srcEl.appendChild(a);
      }
      card.appendChild(srcEl);
    }

    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    metaEl.textContent = new Date(r.created_at).toLocaleString();
    card.appendChild(metaEl);

    resultsList.appendChild(card);
  }
}

function setSteps(steps) {
  stepsList.innerHTML = "";
  for (const s of steps) {
    const li = document.createElement("li");
    li.textContent = s;
    stepsList.appendChild(li);
  }
}

async function runTask() {
  const goal = goalInput.value.trim();
  if (!goal) return;

  runBtn.disabled = true;
  statusEl.classList.remove("hidden");
  setSteps(["Starting..."]);

  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, fileText: attachedFileText }),
    });
    const data = await res.json();
    if (data.steps) setSteps(data.steps);
    // The function already wrote the result (or error) to Supabase — just re-render from there.
  } catch {
    // Network-level failure before the function could even respond; nothing was saved.
  } finally {
    statusEl.classList.add("hidden");
    runBtn.disabled = false;
    goalInput.value = "";
    fileInput.value = "";
    fileNameEl.textContent = "";
    attachedFileText = "";
    await renderResults();
  }
}

runBtn.addEventListener("click", runTask);
goalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runTask();
});

renderResults();
