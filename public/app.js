const goalInput = document.getElementById("goalInput");
const fileInput = document.getElementById("fileInput");
const fileNameEl = document.getElementById("fileName");
const runBtn = document.getElementById("runBtn");
const micBtn = document.getElementById("micBtn");
const statusEl = document.getElementById("status");
const stepsList = document.getElementById("stepsList");
const resultsList = document.getElementById("resultsList");

const sidebar = document.getElementById("sidebar");
const backdrop = document.getElementById("backdrop");
const menuBtn = document.getElementById("menuBtn");
const newChatBtn = document.getElementById("newChatBtn");
const dashboardNavBtn = document.getElementById("dashboardNavBtn");
const convoList = document.getElementById("convoList");
const chatView = document.getElementById("chatView");
const dashboardView = document.getElementById("dashboardView");
const statCards = document.getElementById("statCards");
const integrationList = document.getElementById("integrationList");

let attachedFileText = "";

// The active conversation thread. null = "new chat" — a fresh id is
// generated client-side the moment the first message in it is sent. Kept
// in localStorage (a real deployed website, not a sandboxed Claude
// artifact, so ordinary browser storage is fine here) so refreshing the
// page keeps you in the same thread.
let currentConversationId = localStorage.getItem("mkdai_conversation_id") || null;

function setConversation(id) {
  currentConversationId = id;
  if (id) localStorage.setItem("mkdai_conversation_id", id);
  else localStorage.removeItem("mkdai_conversation_id");
}

// ---- Sidebar ----

function openSidebar() {
  sidebar.classList.add("open");
  backdrop.classList.add("open");
}
function closeSidebar() {
  sidebar.classList.remove("open");
  backdrop.classList.remove("open");
}
menuBtn.addEventListener("click", openSidebar);
backdrop.addEventListener("click", closeSidebar);

async function loadConversations() {
  try {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    const conversations = data.conversations || [];
    convoList.innerHTML = "";
    for (const c of conversations) {
      const item = document.createElement("div");
      item.className = "convo-item" + (c.id === currentConversationId ? " active" : "");
      item.textContent = c.title || "Untitled";
      item.addEventListener("click", () => {
        setConversation(c.id);
        showChatView();
        closeSidebar();
        renderResults();
        loadConversations();
      });
      convoList.appendChild(item);
    }
  } catch {
    // Sidebar list is a nice-to-have; fail silently if it can't load.
  }
}

newChatBtn.addEventListener("click", () => {
  setConversation(null);
  resultsList.innerHTML = "";
  goalInput.value = "";
  showChatView();
  closeSidebar();
  renderResults();
  loadConversations();
});

// ---- View switching (chat vs dashboard) ----

function showChatView() {
  chatView.classList.remove("hidden");
  dashboardView.classList.add("hidden");
  dashboardNavBtn.classList.remove("active");
}

async function showDashboardView() {
  chatView.classList.add("hidden");
  dashboardView.classList.remove("hidden");
  dashboardNavBtn.classList.add("active");
  closeSidebar();
  await loadDashboard();
}

dashboardNavBtn.addEventListener("click", showDashboardView);

async function loadDashboard() {
  statCards.innerHTML = "Loading...";
  integrationList.innerHTML = "";
  try {
    const res = await fetch("/api/dashboard");
    const data = await res.json();
    statCards.innerHTML = "";
    const stats = data.stats || {};
    const cards = [
      ["Tasks today", stats.tasksToday],
      ["Total tasks", stats.totalTasks],
      ["Active schedules", stats.activeScheduled],
      ["Memory facts", stats.memoryFacts],
      ["Conversations", stats.conversations],
      ["Backup Groq keys", (data.backupKeys && data.backupKeys.groq) || 0],
      ["Backup Gemini keys", (data.backupKeys && data.backupKeys.gemini) || 0],
    ];
    for (const [label, num] of cards) {
      const card = document.createElement("div");
      card.className = "stat-card";
      card.innerHTML = `<div class="num">${num ?? "–"}</div><div class="label">${label}</div>`;
      statCards.appendChild(card);
    }
    for (const [name, on] of Object.entries(data.integrations || {})) {
      const row = document.createElement("div");
      row.className = "integration-row";
      row.innerHTML = `<span>${name}</span><span class="integration-status ${on ? "on" : "off"}">${on ? "Connected" : "Not set up"}</span>`;
      integrationList.appendChild(row);
    }
  } catch (err) {
    statCards.innerHTML = `<p style="color:var(--bad); font-size:13px;">Could not load dashboard: ${err.message}</p>`;
  }
}

// ---- Voice input — uses the browser's built-in speech recognition
// (Chrome: webkitSpeechRecognition). Completely free, no API key, works
// client-side. ----
const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isRecording = false;

if (SpeechRecognitionAPI) {
  recognition = new SpeechRecognitionAPI();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";

  recognition.addEventListener("result", (e) => {
    const transcript = e.results[0][0].transcript;
    goalInput.value = goalInput.value ? `${goalInput.value} ${transcript}` : transcript;
  });

  recognition.addEventListener("end", () => {
    isRecording = false;
    micBtn.classList.remove("recording");
  });

  recognition.addEventListener("error", () => {
    isRecording = false;
    micBtn.classList.remove("recording");
  });

  micBtn.addEventListener("click", () => {
    if (isRecording) {
      recognition.stop();
      return;
    }
    isRecording = true;
    micBtn.classList.add("recording");
    recognition.start();
  });
} else {
  micBtn.style.display = "none";
}

// Voice output — the browser's built-in text-to-speech, same idea: free,
// no key, works client-side. Strips markdown symbols so it doesn't read
// asterisks/hashes aloud.
function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const clean = text.replace(/[*_#`]/g, "").replace(/https?:\/\/\S+/g, "a link");
  const utterance = new SpeechSynthesisUtterance(clean);
  window.speechSynthesis.speak(utterance);
}

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
  if (!currentConversationId) return [];
  try {
    const res = await fetch(`/api/tasks?conversationId=${encodeURIComponent(currentConversationId)}`);
    const data = await res.json();
    return data.tasks || [];
  } catch {
    return [];
  }
}

// Detects image URLs (screenshots, or any direct image link) within an
// answer and renders them as actual images, not just clickable text.
function renderAnswerWithImages(container, text) {
  const urlRegex = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp))/gi;
  let lastIndex = 0;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) container.appendChild(document.createTextNode(before));
    const img = document.createElement("img");
    img.src = match[1];
    img.alt = "Screenshot";
    img.loading = "lazy";
    img.style.maxWidth = "100%";
    img.style.borderRadius = "8px";
    img.style.margin = "8px 0";
    img.style.display = "block";
    container.appendChild(img);
    lastIndex = match.index + match[1].length;
  }
  const rest = text.slice(lastIndex);
  if (rest) container.appendChild(document.createTextNode(rest));
}

async function renderResults() {
  const results = await fetchResults();
  resultsList.innerHTML = "";
  if (results.length === 0) {
    resultsList.innerHTML = '<p style="color:var(--muted); font-size:13px;">Nothing yet — start a new chat above.</p>';
    return;
  }
  // Oldest first within a thread, like a normal chat.
  const ordered = [...results].reverse();
  for (const r of ordered) {
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
      const liveLabel = document.createElement("div");
      liveLabel.className = "live-label";
      liveLabel.textContent = "Working — live progress:";
      answerEl.appendChild(liveLabel);
      const liveSteps = document.createElement("div");
      liveSteps.className = "live-steps";
      const stepsSoFar = r.steps || [];
      if (stepsSoFar.length === 0) {
        liveSteps.textContent = "Starting...";
      } else {
        for (const s of stepsSoFar) {
          const stepEl = document.createElement("div");
          stepEl.className = "live-step";
          renderAnswerWithImages(stepEl, s);
          liveSteps.appendChild(stepEl);
        }
      }
      answerEl.appendChild(liveSteps);
      const stopBtn = document.createElement("button");
      stopBtn.className = "speak-btn";
      stopBtn.textContent = "⏹ Stop";
      stopBtn.addEventListener("click", async () => {
        stopBtn.disabled = true;
        stopBtn.textContent = "Stopping...";
        try {
          await fetch("/api/cancel-task", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId: r.id }),
          });
        } catch {
          // best-effort — the running task will pick this up shortly regardless
        }
      });
      answerEl.appendChild(stopBtn);
    } else {
      renderAnswerWithImages(answerEl, r.answer || "");
      if (r.answer) {
        const speakBtn = document.createElement("button");
        speakBtn.className = "speak-btn";
        speakBtn.textContent = "🔊 Read aloud";
        speakBtn.addEventListener("click", () => speakText(r.answer));
        answerEl.appendChild(speakBtn);
      }
    }
    if (isError) {
      const retryBtn = document.createElement("button");
      retryBtn.className = "speak-btn";
      retryBtn.textContent = "🔁 Retry";
      retryBtn.addEventListener("click", () => {
        goalInput.value = r.goal;
        runTask();
      });
      answerEl.appendChild(retryBtn);
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
  resultsList.scrollTop = resultsList.scrollHeight;
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

  // First message in a "new chat" gets its own thread id right away —
  // needed up front since the background function can't hand one back.
  if (!currentConversationId) {
    setConversation(crypto.randomUUID());
  }

  runBtn.disabled = true;
  statusEl.classList.remove("hidden");
  setSteps(["Starting... (this now runs in the background — you can even close this tab, and you'll get an email when it's done if notifications are set up)"]);

  try {
    await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal, fileText: attachedFileText, conversationId: currentConversationId }),
    });
    // Background function returns instantly and keeps working server-side.
    // Poll for a while so the UI updates once it's actually done.
    await renderResults();
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const results = await fetchResults();
      const stillRunning = results.some((r) => r.goal === goal && (r.status === "running" || r.status === "pending"));
      await renderResults();
      if (!stillRunning) break;
    }
    loadConversations();
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

loadConversations();
renderResults();
