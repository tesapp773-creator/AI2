const STORAGE_KEY = "mkdai_results_v1";

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

function loadResults() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveResult(entry) {
  const results = loadResults();
  results.unshift(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(results.slice(0, 50)));
}

function renderResults() {
  const results = loadResults();
  resultsList.innerHTML = "";
  if (results.length === 0) {
    resultsList.innerHTML = '<p style="color:var(--muted); font-size:13px;">Nothing yet — run a task above.</p>';
    return;
  }
  for (const r of results) {
    const card = document.createElement("div");
    card.className = "result-card" + (r.error ? " error" : "");

    const goalEl = document.createElement("div");
    goalEl.className = "goal";
    goalEl.textContent = r.goal;
    card.appendChild(goalEl);

    const answerEl = document.createElement("div");
    answerEl.className = "answer";
    answerEl.textContent = r.error ? `Error: ${r.error}` : r.answer;
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
    metaEl.textContent = new Date(r.timestamp).toLocaleString();
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

    if (!res.ok) {
      saveResult({ goal, error: data.error || "Something went wrong", timestamp: Date.now() });
    } else {
      saveResult({ goal, answer: data.answer, sources: data.sources, timestamp: Date.now() });
    }
  } catch (err) {
    saveResult({ goal, error: err.message, timestamp: Date.now() });
  } finally {
    statusEl.classList.add("hidden");
    runBtn.disabled = false;
    goalInput.value = "";
    fileInput.value = "";
    fileNameEl.textContent = "";
    attachedFileText = "";
    renderResults();
  }
}

runBtn.addEventListener("click", runTask);
goalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runTask();
});

renderResults();
