import { splitCodexContext } from "./session-context.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const state = {
  catalog: [], chosen: new Set(), preview: null, mode: "standard", disabledKinds: new Set(), disabledMatches: new Set(),
  acceptedId: "", busy: false, review: null, sessionPage: 0, reviewIndex: 0, messagePage: 0,
};

function setHidden(element, hidden) { element.classList.toggle("hidden", hidden); }
function formatBytes(value) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.ceil(value / 1_000)} KB`; }
function setError(message = "") { elements.error.textContent = message; }
function clearReview() {
  state.preview = null; state.review = null;
  setHidden(elements["review-placeholder"], false);
  setHidden(elements["review-content"], true);
  elements["custom-status"].textContent = "";
  elements["preview-button"].textContent = "Preview data";
}
function invalidateConsent() {
  elements.consent.checked = false;
  elements["unredacted-ack"].checked = false;
  updateDonateButton();
}
function updateDonateButton() {
  const messages = state.preview?.sessions.reduce((sum, session) => sum + session.messages.length, 0) || 0;
  const hasEmptyMessage = (state.preview?.sessions.some((session) => session.messages.some((message) => !message.text.trim())) || false);
  setHidden(elements["message-validation"], !hasEmptyMessage);
  elements.donate.disabled = state.busy || !messages || hasEmptyMessage || !elements.consent.checked || (state.mode === "unredacted" && !elements["unredacted-ack"].checked);
}

function renderSessions() {
  elements.sessions.replaceChildren();
  for (const session of state.catalog.slice(state.sessionPage * 30, (state.sessionPage + 1) * 30)) {
    const label = document.createElement("label"); label.className = "session";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = state.chosen.has(session.id);
    input.addEventListener("change", () => { input.checked ? state.chosen.add(session.id) : state.chosen.delete(session.id); clearReview(); invalidateConsent(); renderSelectionCount(); });
    const copy = document.createElement("span");
    const strong = document.createElement("strong"); strong.textContent = session.title || `${session.agentName} · ${new Date(session.startedAt).toLocaleDateString()}`;
    strong.title = strong.textContent;
    const preview = document.createElement("span"); preview.className = "session-excerpt";
    preview.textContent = session.firstUserMessage || "No user message available";
    preview.title = preview.textContent;
    const small = document.createElement("small"); small.textContent = `${session.title ? `${session.agentName} · ${new Date(session.startedAt).toLocaleDateString()} · ` : ""}${session.messageCount} messages · ${formatBytes(session.sizeBytes)}`;
    copy.append(strong, preview, small); label.append(input, copy); elements.sessions.append(label);
  }
  elements["session-page"].textContent = `${state.sessionPage + 1} / ${Math.max(1, Math.ceil(state.catalog.length / 30))}`;
  elements["sessions-prev"].disabled = state.sessionPage === 0;
  elements["sessions-next"].disabled = (state.sessionPage + 1) * 30 >= state.catalog.length;
  renderSelectionCount();
}

function renderSelectionCount() {
  elements["selection-count"].textContent = `${state.chosen.size} of ${state.catalog.length} selected`;
  elements["select-all"].checked = state.chosen.size === state.catalog.length && state.catalog.length > 0;
  elements["select-all"].indeterminate = state.chosen.size > 0 && state.chosen.size < state.catalog.length;
  elements["preview-button"].disabled = !state.chosen.size || state.busy;
}

function renderMode() {
  const descriptions = {
    standard: "Automatically removes high-confidence credentials and common personal identifiers. Review all messages before donating.",
    custom: "Starts with all standard redactions applied. Adjust automatic rules or add marked redactions below; message text cannot be rewritten.",
    unredacted: "Disables automatic redaction. Every included line must be reviewed, and an additional acknowledgement is required.",
  };
  elements["mode-description"].textContent = descriptions[state.mode];
  setHidden(elements["custom-redaction"], state.mode !== "custom" || !state.preview);
  setHidden(elements["unredacted-consent"], state.mode !== "unredacted");
  elements.donate.firstChild.textContent = state.mode === "unredacted" ? "Donate unredacted data " : "Donate reviewed data ";
}

async function api(url, method = "GET", body) {
  const response = await fetch(url, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The local request failed.");
  return result;
}

function lockControls(locked) {
  for (const control of elements.workspace.querySelectorAll("input, select, textarea, button")) control.disabled = locked;
  if (!locked) { renderSelectionCount(); updateDonateButton(); updateNavigation(); }
}
function updateNavigation() {
  elements["sessions-prev"].disabled = state.busy || state.sessionPage === 0;
  elements["sessions-next"].disabled = state.busy || (state.sessionPage + 1) * 30 >= state.catalog.length;
  elements["messages-prev"].disabled = state.busy || state.messagePage === 0;
  elements["messages-next"].disabled = state.busy || (state.messagePage + 1) * 40 >= (state.preview?.sessions[0]?.messages.length || 0);
  elements["review-prev"].disabled = state.busy || state.reviewIndex === 0;
  elements["review-next"].disabled = state.busy || state.reviewIndex + 1 >= (state.review?.sessions.length || 0);
  elements["review-position"].value = state.reviewIndex + 1;
  elements["review-position"].max = state.review?.sessions.length || 1;
  elements["review-total"].textContent = `of ${state.review?.sessions.length || 0} sessions`;
}
async function loadReviewSession(index) {
  if (!state.review || index < 0 || index >= state.review.sessions.length) return;
  const preview = await api(`/api/reviews/${state.review.id}/sessions/${index}`);
  state.reviewIndex = index; state.messagePage = 0; state.preview = preview;
  renderReview(); updateNavigation();
}
async function navigateReview(index) {
  if (state.busy) return;
  state.busy = true; lockControls(true); setError();
  try { await loadReviewSession(index); } catch (error) { setError(error.message); }
  finally { state.busy = false; lockControls(false); }
}
async function pollReview() {
  while (true) {
    state.review = { ...state.review, ...await api(`/api/reviews/${state.review.id}`) };
    const job = state.review;
    elements["progress"].textContent = job.status === "preparing" ? `Preparing ${job.processed} of ${job.total} sessions…` : job.status === "uploading" ? `Uploaded ${job.uploaded} of ${job.batches} batches. Keep this app open.` : "";
    if (!["preparing", "uploading"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}
async function buildPreview(index = 0) {
  if (state.busy) return;
  state.busy = true; setError(); invalidateConsent(); lockControls(true);
  elements["custom-status"].textContent = "";
  elements["preview-button"].textContent = "Preparing preview…";
  try {
    state.review = await api("/api/reviews", "POST", { sessionIds: [...state.chosen], mode: state.mode, disabledKinds: [...state.disabledKinds], disabledMatches: [...state.disabledMatches] });
    const job = await pollReview();
    if (job.status !== "ready") throw new Error(job.error || "Could not prepare the review.");
    await loadReviewSession(Math.min(index, job.sessions.length - 1));
  } catch (error) { clearReview(); setError(error.message); }
  finally { state.busy = false; elements["preview-button"].textContent = "Refresh preview"; lockControls(false); }
}

function redactionCheckbox(item, match = null) {
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = match ? match.enabled : item.enabled;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    if (match && input.checked) {
      if (state.disabledKinds.delete(item.kind)) for (const other of item.matches) if (other.id !== match.id) state.disabledMatches.add(other.id);
      state.disabledMatches.delete(match.id);
    } else if (match) state.disabledMatches.add(match.id);
    else if (input.checked) {
      state.disabledKinds.delete(item.kind);
      for (const existing of item.matches) state.disabledMatches.delete(existing.id);
    } else state.disabledKinds.add(item.kind);
    void buildPreview(state.reviewIndex);
  });
  return input;
}

function renderRedactions() {
  elements.redactions.replaceChildren();
  if (state.mode === "unredacted") return;
  const wrapper = document.createElement("div"); wrapper.className = "redactions";
  for (const item of state.preview.redactions) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    if (state.mode === "custom") summary.append(redactionCheckbox(item));
    const label = document.createElement("span"); label.textContent = item.label;
    const count = document.createElement("b"); count.textContent = `${item.enabledCount}/${item.count}`;
    summary.append(label, count); details.append(summary);
    const matches = document.createElement("div"); matches.className = "matches";
    for (const match of item.matches) {
      const row = document.createElement("div"); row.className = "match";
      if (state.mode === "custom") row.append(redactionCheckbox(item, match), " ");
      const code = document.createElement("code"); code.textContent = match.value; row.append(code, ` · ${match.count}×`);
      matches.append(row);
    }
    details.append(matches); wrapper.append(details);
  }
  if (!state.preview.redactions.length) {
    const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No automatic matches were found. Automated detection is not exhaustive."; wrapper.append(empty);
  }
  elements.redactions.append(wrapper);
}

function renderConversations() {
  elements["conversation-preview"].replaceChildren();
  state.preview.sessions.forEach((session, sessionIndex) => {
    const details = document.createElement("details"); details.className = "conversation"; if (sessionIndex === 0) details.open = true;
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    const strong = document.createElement("strong"); strong.textContent = session.label;
    const small = document.createElement("small"); small.textContent = session.summary;
    const count = document.createElement("b"); count.textContent = `${session.messages.length} messages`;
    title.append(strong, small); summary.append(title, count); details.append(summary);
    const messages = document.createElement("div"); messages.className = "messages";
    session.messages.slice(state.messagePage * 40, (state.messagePage + 1) * 40).forEach((message) => {
      const parts = session.source === "codex" && message.role === "user" ? splitCodexContext(message.text) : { context: "", text: message.text };
      const transcript = (part, label) => {
        const text = document.createElement("pre"); text.className = "transcript-text";
        text.textContent = parts[part]; text.setAttribute("aria-label", label); text.tabIndex = 0;
        return text;
      };
      if (parts.context) {
        const context = document.createElement("details"); context.className = "message-context";
        const heading = document.createElement("summary"); heading.textContent = "Codex context · included in donation";
        context.append(heading, transcript("context", "Codex context")); messages.append(context);
      }
      if (parts.text || !parts.context) {
        const row = document.createElement("div"); row.className = `message ${message.role === "user" ? "message-user" : "message-agent"}`;
        const role = document.createElement("span"); role.textContent = message.role === "assistant" ? "Agent" : "You";
        const label = `${role.textContent} message`;
        if (message.timestamp) {
          const time = document.createElement("time"); time.dateTime = message.timestamp;
          time.textContent = new Date(message.timestamp).toLocaleString(); time.title = message.timestamp;
          role.append(" · ", time);
        }
        row.append(role, transcript("text", label)); messages.append(row);
      }
    });
    details.append(messages); elements["conversation-preview"].append(details);
  });
  const total = state.preview.sessions[0].messages.length;
  elements["message-page"].textContent = `Messages ${state.messagePage * 40 + 1}–${Math.min(total, (state.messagePage + 1) * 40)} of ${total}`;
  elements["messages-prev"].disabled = state.messagePage === 0;
  elements["messages-next"].disabled = (state.messagePage + 1) * 40 >= total;
}

function renderReview() {
  setHidden(elements["review-placeholder"], true); setHidden(elements["review-content"], false);
  const messages = state.preview.sessions.reduce((sum, session) => sum + session.messages.length, 0);
  if (state.mode === "unredacted") {
    elements.warning.className = "banner danger";
    elements.warning.textContent = "No automatic redactions are active. Credentials, personal details, code, URLs, and paths may be present.";
    elements["redaction-summary"].textContent = `${state.review.sessions.length} sessions · ${state.review.messages.toLocaleString()} messages selected.`;
  } else {
    elements.warning.className = "banner";
    elements.warning.textContent = `${state.preview.detectionCount} likely sensitive items removed in this session`;
    elements["redaction-summary"].textContent = `${state.review.sessions.length} sessions · ${state.review.messages.toLocaleString()} messages selected. Showing one session below.`;
    elements["redaction-summary"].className = "hint";
  }
  renderRedactions(); renderConversations(); renderMode(); updateDonateButton();
}

async function applyCustomRedaction() {
  if (state.busy || state.mode !== "custom" || !state.preview) return;
  const pattern = elements["custom-pattern"].value;
  if (!pattern) return elements["custom-status"].textContent = "Enter text or a regular expression.";
  state.busy = true; invalidateConsent(); lockControls(true);
  try {
    const result = await api(`/api/reviews/${state.review.id}/sessions/${state.reviewIndex}`, "POST", { pattern, type: elements["custom-mode"].value });
    state.preview = result.preview;
    elements["custom-status"].textContent = result.count ? `Applied ${result.count} redaction${result.count === 1 ? "" : "s"}. Refresh the preview to undo.` : "No matches found.";
    if (result.count) elements["custom-pattern"].value = "";
    renderConversations();
  } catch (error) { elements["custom-status"].textContent = error.message; }
  finally { state.busy = false; lockControls(false); }
}

async function donate() {
  if (state.busy) return;
  state.busy = true; setError(); lockControls(true);
  try {
    await api(`/api/reviews/${state.review.id}/donate`, "POST", { researchDonation: elements.consent.checked, unredactedData: elements["unredacted-ack"].checked });
    const job = await pollReview();
    if (job.status !== "complete") throw new Error(job.error || "Upload paused. Retry to continue.");
    state.acceptedId = job.donationId;
    if (state.acceptedId === "demo-not-transmitted") elements["success-description"].textContent = "Demo complete. No data was transmitted and no donation receipt was saved.";
    elements["donation-id"].textContent = state.acceptedId;
    elements["delete-donation"].classList.toggle("hidden", !/^[0-9a-f-]{36}$/.test(state.acceptedId));
    setHidden(elements.workspace, true); setHidden(elements.success, false);
  } catch (error) { setError(error.message); }
  finally {
    state.busy = false;
    if (state.review?.status === "paused") {
      elements.donate.disabled = false; elements.donate.textContent = "Retry remaining upload";
      elements["progress"].textContent = `${state.review.uploaded} of ${state.review.batches} batches accepted. Your deletion receipt also covers partial uploads.`;
    } else lockControls(false);
  }
}

async function closeApp() {
  elements["close-app"].disabled = true;
  try {
    await api("/api/shutdown", "POST");
    elements["close-status"].textContent = "Local server stopped. You can close this tab.";
    elements["close-app"].textContent = "Server stopped";
    elements["delete-donation"].disabled = true;
    window.close();
  } catch (error) { elements["close-status"].textContent = error.message; elements["close-app"].disabled = false; }
}

async function deleteAcceptedDonation() {
  elements["delete-donation"].disabled = true; elements["delete-status"].textContent = "Deleting…";
  try {
    const response = await fetch(`/api/donations/${state.acceptedId}`, { method: "DELETE" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Deletion failed.");
    elements["delete-status"].textContent = "Deleted from active research storage.";
    elements["delete-donation"].classList.add("hidden");
  } catch (error) { elements["delete-status"].textContent = error.message; elements["delete-donation"].disabled = false; }
}

elements["select-all"].addEventListener("change", () => {
  state.chosen = elements["select-all"].checked ? new Set(state.catalog.map((session) => session.id)) : new Set();
  clearReview(); invalidateConsent(); renderSessions();
});
elements.mode.addEventListener("change", () => {
  const hadPreview = Boolean(state.preview), index = state.reviewIndex;
  state.mode = elements.mode.value; state.disabledKinds.clear(); state.disabledMatches.clear();
  clearReview(); invalidateConsent(); renderMode();
  if (hadPreview) void buildPreview(index);
});
elements["sessions-prev"].addEventListener("click", () => { state.sessionPage--; renderSessions(); });
elements["sessions-next"].addEventListener("click", () => { state.sessionPage++; renderSessions(); });
elements["review-prev"].addEventListener("click", () => navigateReview(state.reviewIndex - 1));
elements["review-next"].addEventListener("click", () => navigateReview(state.reviewIndex + 1));
elements["review-position"].addEventListener("change", () => navigateReview(Number(elements["review-position"].value) - 1));
elements["messages-prev"].addEventListener("click", () => { state.messagePage--; renderConversations(); });
elements["messages-next"].addEventListener("click", () => { state.messagePage++; renderConversations(); });
elements["close-app"].addEventListener("click", closeApp);
elements["preview-button"].addEventListener("click", () => buildPreview());
elements["apply-custom"].addEventListener("click", applyCustomRedaction);
elements.consent.addEventListener("change", updateDonateButton);
elements["unredacted-ack"].addEventListener("change", updateDonateButton);
elements.donate.addEventListener("click", donate);
elements["delete-donation"].addEventListener("click", deleteAcceptedDonation);

fetch("/api/catalog").then(async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Could not read local sessions.");
  state.catalog = body.sessions; state.chosen = new Set(body.sessions.map((session) => session.id));
  setHidden(elements.loading, true);
  if (!state.catalog.length) return setHidden(elements.empty, false);
  setHidden(elements.workspace, false); renderSessions(); renderMode();
}).catch((error) => { elements.loading.textContent = error.message; });
