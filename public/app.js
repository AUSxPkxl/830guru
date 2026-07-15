const state = {
  status: null,
  unit: localStorage.getItem("830e.unit") || "",
  messages: JSON.parse(localStorage.getItem("830e.messages") || "[]"),
  lastAnswer: ""
};

const elements = {
  modePill: document.querySelector("#modePill"),
  unitNumber: document.querySelector("#unitNumber"),
  saveUnit: document.querySelector("#saveUnit"),
  dialog: document.querySelector("#unitDialog"),
  dialogUnit: document.querySelector("#dialogUnit"),
  dialogSave: document.querySelector("#dialogSave"),
  messages: document.querySelector("#messages"),
  messageInput: document.querySelector("#messageInput"),
  chatForm: document.querySelector("#chatForm"),
  historyList: document.querySelector("#historyList"),
  clearHistory: document.querySelector("#clearHistory"),
  sources: document.querySelector("#sources"),
  uploadForm: document.querySelector("#uploadForm"),
  docInput: document.querySelector("#docInput"),
  reindexButton: document.querySelector("#reindexButton"),
  manualList: document.querySelector("#manualList"),
  noteForm: document.querySelector("#noteForm"),
  noteTitle: document.querySelector("#noteTitle"),
  noteBody: document.querySelector("#noteBody"),
  notePhoto: document.querySelector("#notePhoto"),
  notesList: document.querySelector("#notesList"),
  copyLast: document.querySelector("#copyLast"),
  printLast: document.querySelector("#printLast")
};

boot();

async function boot() {
  elements.unitNumber.value = state.unit;
  renderMessages();
  renderHistory();
  renderEmptySources();
  bindEvents();
  await refreshStatus();
  await refreshNotes();
  if (!state.unit && elements.dialog.showModal) {
    elements.dialog.showModal();
    elements.dialogUnit.focus();
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }
}

function bindEvents() {
  elements.saveUnit.addEventListener("click", () => saveUnit(elements.unitNumber.value));
  elements.dialogSave.addEventListener("click", () => {
    saveUnit(elements.dialogUnit.value);
    elements.dialog.close();
  });

  document.querySelectorAll(".quick-btn").forEach((button) => {
    button.addEventListener("click", () => {
      elements.messageInput.value = button.dataset.prompt || "";
      elements.messageInput.focus();
    });
  });

  elements.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await askQuestion();
  });

  elements.clearHistory.addEventListener("click", () => {
    state.messages = [];
    state.lastAnswer = "";
    saveMessages();
    renderMessages();
    renderHistory();
    renderEmptySources();
  });

  elements.uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await uploadDocuments();
  });

  elements.reindexButton.addEventListener("click", async () => {
    await reindexManuals();
  });

  elements.noteForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveNote();
  });

  elements.copyLast.addEventListener("click", async () => {
    if (!state.lastAnswer) return;
    await navigator.clipboard.writeText(state.lastAnswer);
  });

  elements.printLast.addEventListener("click", () => window.print());
}

function saveUnit(value) {
  state.unit = String(value || "").trim();
  localStorage.setItem("830e.unit", state.unit);
  elements.unitNumber.value = state.unit;
}

async function refreshStatus() {
  const response = await fetch("/api/status");
  state.status = await response.json();
  const manualCount = state.status.manuals.length;
  const indexCount = state.status.indexCount || 0;
  const indexLabel = `${manualCount} PDFs, ${indexCount} pages`;
  elements.modePill.textContent = state.status.mode === "ai"
    ? `AI ready, ${indexLabel}`
    : `Source-only demo, ${indexLabel}`;
  elements.modePill.classList.toggle("demo", state.status.mode !== "ai" || indexCount === 0);
  renderManuals(state.status.manuals);
}

async function askQuestion() {
  const text = elements.messageInput.value.trim();
  if (!text) return;
  const unitPrefix = state.unit ? `Truck ${state.unit}: ` : "";
  const userMessage = { role: "user", content: `${unitPrefix}${text}`, createdAt: new Date().toISOString() };
  state.messages.push(userMessage);
  elements.messageInput.value = "";
  saveMessages();
  renderMessages();
  renderHistory();

  const pending = { role: "assistant", content: "Searching provided 830E-1AC sources...", createdAt: new Date().toISOString(), pending: true };
  state.messages.push(pending);
  renderMessages();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: text,
        unit: state.unit,
        history: state.messages.filter((item) => !item.pending).slice(-10)
      })
    });
    const result = await response.json();
    pending.pending = false;
    pending.content = result.answer;
    pending.sources = result.sources || [];
    pending.createdAt = new Date().toISOString();
    state.lastAnswer = result.answer;
    saveMessages();
    renderMessages();
    renderSources(pending.sources);
  } catch (error) {
    pending.pending = false;
    pending.content = `I could not complete the request: ${error.message}`;
    saveMessages();
    renderMessages();
  }
}

function saveMessages() {
  localStorage.setItem("830e.messages", JSON.stringify(state.messages.slice(-80)));
}

function renderMessages() {
  elements.messages.innerHTML = "";
  if (!state.messages.length) {
    const intro = document.createElement("article");
    intro.className = "message";
    intro.innerHTML = `
      <div class="message-header"><span>System</span><span>Ready</span></div>
      <div class="message-body">Add your Komatsu 830E-1AC PDFs, set the truck number, then ask for a fault code, torque spec, procedure, or pressure. I am configured to avoid guessing when a provided source is missing.</div>
      <div class="safety-note">Safety-critical work should always be checked against the exact manual page and site procedure before use.</div>
    `;
    elements.messages.appendChild(intro);
    return;
  }

  state.messages.forEach((message) => {
    const article = document.createElement("article");
    article.className = `message ${message.role === "user" ? "user" : "assistant"}`;
    const label = message.role === "user" ? "You" : "830E Guru";
    article.innerHTML = `
      <div class="message-header">
        <span>${escapeHtml(label)}</span>
        <span>${formatTime(message.createdAt)}</span>
      </div>
      <div class="message-body">${escapeHtml(message.content)}</div>
    `;
    if (message.role === "assistant" && /high voltage|brak|steer|hydraulic|lifting|stored energy|lockout|tagout/i.test(message.content)) {
      const safety = document.createElement("div");
      safety.className = "safety-note";
      safety.textContent = "Safety layer: verify isolation, stored energy release, and site procedure before acting.";
      article.appendChild(safety);
    }
    elements.messages.appendChild(article);
  });
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderHistory() {
  const questions = state.messages.filter((item) => item.role === "user").slice(-16).reverse();
  elements.historyList.innerHTML = "";
  if (!questions.length) {
    elements.historyList.innerHTML = `<p class="empty-state">No questions yet.</p>`;
    return;
  }
  questions.forEach((question) => {
    const button = document.createElement("button");
    button.className = "history-item";
    button.type = "button";
    button.innerHTML = `${escapeHtml(question.content)}<small>${formatTime(question.createdAt)}</small>`;
    button.addEventListener("click", () => {
      elements.messageInput.value = question.content.replace(/^Truck [^:]+:\s*/, "");
      elements.messageInput.focus();
    });
    elements.historyList.appendChild(button);
  });
}

function renderSources(sources) {
  elements.sources.innerHTML = "";
  if (!sources || !sources.length) {
    renderEmptySources();
    return;
  }
  sources.forEach((source) => {
    const card = document.createElement("article");
    card.className = "source-card";
    const thumb = source.pageImage
      ? `<img alt="Manual page thumbnail" src="${escapeHtml(source.pageImage)}">`
      : `<div class="page-lines"></div><span>PAGE ${escapeHtml(String(source.page || "PENDING"))}</span>`;
    card.innerHTML = `
      <div class="page-thumb">${thumb}</div>
      <div>
        <h3>${escapeHtml(source.title || "Source")}</h3>
        <p>${escapeHtml(source.manual || "Manual pending")} ${source.page ? `- page ${escapeHtml(String(source.page))}` : ""}</p>
        <p>${escapeHtml(source.quote || "Page image will appear after PDF rendering is enabled.")}</p>
      </div>
    `;
    elements.sources.appendChild(card);
  });
}

function renderEmptySources() {
  const template = document.querySelector("#emptySourceTemplate");
  elements.sources.innerHTML = "";
  elements.sources.appendChild(template.content.cloneNode(true));
}

function renderManuals(manuals) {
  elements.manualList.innerHTML = "";
  if (!manuals.length) {
    elements.manualList.innerHTML = `<p class="empty-state">No PDFs added yet.</p>`;
    return;
  }
  manuals.forEach((manual) => {
    const row = document.createElement("a");
    row.className = "manual-item";
    row.href = manual.url;
    row.target = "_blank";
    row.rel = "noreferrer";
    row.innerHTML = `
      <strong>${escapeHtml(manual.name)}</strong>
      <small>${formatBytes(manual.size)} - opens PDF</small>
    `;
    elements.manualList.appendChild(row);
  });
}

async function uploadDocuments() {
  const files = Array.from(elements.docInput.files || []);
  if (!files.length) return;
  const form = new FormData();
  files.forEach((file) => form.append("manuals", file));
  elements.modePill.textContent = "Uploading PDFs";
  const response = await fetch("/api/documents", { method: "POST", body: form });
  if (!response.ok) {
    elements.modePill.textContent = "Upload failed";
    return;
  }
  elements.docInput.value = "";
  await refreshStatus();
}

async function reindexManuals() {
  elements.modePill.textContent = "Indexing manuals";
  elements.reindexButton.disabled = true;
  try {
    const response = await fetch("/api/reindex", { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.detail || result.error || "Indexing failed");
    elements.modePill.textContent = `Indexed ${result.indexCount || 0} pages`;
    await refreshStatus();
  } catch (error) {
    elements.modePill.textContent = "Indexing failed";
    alert(`Indexing failed: ${error.message}`);
  } finally {
    elements.reindexButton.disabled = false;
  }
}

async function refreshNotes() {
  const response = await fetch("/api/notes");
  const data = await response.json();
  renderNotes(data.notes || []);
}

async function saveNote() {
  const title = elements.noteTitle.value.trim();
  const body = elements.noteBody.value.trim();
  const photoFile = elements.notePhoto.files && elements.notePhoto.files[0];
  if (!title && !body && !photoFile) return;
  const photoData = photoFile ? await readFileAsDataUrl(photoFile) : "";
  await fetch("/api/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ unit: state.unit, title, body, photoData, photoName: photoFile && photoFile.name })
  });
  elements.noteTitle.value = "";
  elements.noteBody.value = "";
  elements.notePhoto.value = "";
  await refreshNotes();
}

function renderNotes(notes) {
  elements.notesList.innerHTML = "";
  if (!notes.length) {
    elements.notesList.innerHTML = `<p class="empty-state">No unit notes yet.</p>`;
    return;
  }
  notes.slice(0, 12).forEach((note) => {
    const item = document.createElement("article");
    item.className = "note-item";
    item.innerHTML = `
      <strong>${escapeHtml(note.title || "Untitled note")}</strong>
      <p>${escapeHtml(note.body || "")}</p>
      ${note.photo && note.photo.url ? `<img class="note-photo" alt="Attached note photo" src="${escapeHtml(note.photo.url)}">` : ""}
      <small>${escapeHtml(note.unit || "No unit")} - ${formatTime(note.createdAt)}</small>
    `;
    elements.notesList.appendChild(item);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}
