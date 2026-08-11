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
  setSteps(["Starting... (this now runs in the background — you can even close this tab, and you'll get an email when it's done if notifications are set up)"]);

  try {
    await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, fileText: attachedFileText }),
    });
    // Background function returns instantly and keeps working server-side.
    // Poll for a while so the UI updates once it's actually done.
    await renderResults();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const results = await fetchResults();
      const stillRunning = results.some((r) => r.goal === goal && (r.status === "running" || r.status === "pending"));
      await renderResults();
      if (!stillRunning) break;
    }
  } catch {
    // Network-level failure before the request could even be sent.
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
