import { splitCodexContext } from "./session-context.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const state = {
  catalog: [], chosen: new Set(), preview: null, mode: "standard", disabledKinds: new Set(), disabledMatches: new Set(),
  acceptedId: "", busy: false, review: null, sessionPage: 0, reviewIndex: 0, messagePage: 0,
  activeId: "", filtered: [], revision: 0, building: false, updating: false, previewRequest: 0, timer: null, customRedactionCount: 0, redactionFocus: null,
};

function setHidden(element, hidden) { element.classList.toggle("hidden", hidden); }
function formatBytes(value) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.ceil(value / 1_000)} KB`; }
function setError(message = "") { elements.error.textContent = message; }
function clearReview() {
  state.preview = null; state.review = null;
  setHidden(elements["review-placeholder"], false);
  setHidden(elements["review-content"], true);
  elements["custom-status"].textContent = "";
  clearCustomError();
  elements["review-placeholder"].textContent = "Loading session…";
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
  elements.donate.disabled = state.busy || state.updating || state.review?.status !== "ready" || !state.chosen.size || !messages || hasEmptyMessage || !elements.consent.checked || (state.mode === "unredacted" && !elements["unredacted-ack"].checked);
}

function renderSessions() {
  const scrollTop = elements.sessions.scrollTop;
  elements.sessions.replaceChildren();
  for (const session of state.filtered.slice(state.sessionPage * 30, (state.sessionPage + 1) * 30)) {
    const row = document.createElement("div"); row.className = "session";
    const name = session.title || `${session.agentName} · ${new Date(session.startedAt).toLocaleDateString()}`;
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = state.chosen.has(session.id);
    input.setAttribute("aria-label", `Include ${name} in donation`); input.disabled = state.busy;
    input.addEventListener("change", () => { input.checked ? state.chosen.add(session.id) : state.chosen.delete(session.id); renderSelectionCount(); scheduleReview(); });
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "session-open";
    copy.setAttribute("aria-label", `View ${name}`); copy.dataset.sessionId = session.id; copy.disabled = state.busy;
    const strong = document.createElement("strong"); strong.textContent = name; strong.title = name;
    const preview = document.createElement("span"); preview.className = "session-excerpt";
    preview.textContent = session.firstUserMessage || "No user message available"; preview.title = preview.textContent;
    const small = document.createElement("small"); small.textContent = `${session.title ? `${session.agentName} · ${new Date(session.startedAt).toLocaleDateString()} · ` : ""}${session.messageCount} messages · ${formatBytes(session.sizeBytes)}`;
    copy.append(strong, preview, small);
    copy.addEventListener("click", () => void showSession(session.id));
    row.append(input, copy); elements.sessions.append(row);
  }
  if (!state.filtered.length) {
    const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No matching sessions."; elements.sessions.append(empty);
  }
  elements.sessions.scrollTop = scrollTop;
  elements["session-page"].textContent = `Page ${state.sessionPage + 1} of ${Math.max(1, Math.ceil(state.filtered.length / 30))}`;
  setHidden(elements["session-pagination"], state.filtered.length <= 30);
  renderSelectionCount(); highlightSession(); updateNavigation();
}

function highlightSession() {
  for (const button of elements.sessions.querySelectorAll(".session-open")) {
    const active = button.dataset.sessionId === state.activeId;
    button.setAttribute("aria-current", active ? "true" : "false");
    button.closest(".session").classList.toggle("active", active);
  }
}

function renderSelectionCount() {
  elements["selection-count"].textContent = `${state.chosen.size} of ${state.catalog.length} selected`;
  elements["select-all"].checked = state.chosen.size === state.catalog.length && state.catalog.length > 0;
  elements["select-all"].indeterminate = state.chosen.size > 0 && state.chosen.size < state.catalog.length;
}

function renderMode() {
  const descriptions = {
    standard: "Automatically removes high-confidence credentials and common personal identifiers. Review all messages before donating.",
    custom: "Starts with all standard redactions applied. Adjust automatic rules or add marked redactions below; message text cannot be rewritten.",
    unredacted: "Disables automatic redaction. Every included line must be reviewed, and an additional acknowledgement is required.",
  };
  elements["mode-description"].textContent = descriptions[state.mode];
  elements["saved-redactions"].textContent = state.customRedactionCount ? state.mode === "custom"
    ? "Your saved custom redactions are applied to included sessions."
    : "Your custom redactions are saved but not applied in this mode. Choose Customize redactions to apply them." : "";
  setHidden(elements["custom-redaction"], state.mode !== "custom" || !state.preview || !state.chosen.has(state.activeId));
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
  for (const control of elements.workspace.querySelectorAll("input, select, button")) control.disabled = locked;
  if (!locked) {
    for (const control of elements["custom-redaction"].querySelectorAll("input, select, button")) control.disabled = state.updating || !state.preview;
    for (const control of elements.redactions.querySelectorAll("input")) control.disabled = state.updating || !state.preview;
    elements.consent.disabled = state.updating || !state.preview || !state.chosen.size || state.review?.status !== "ready";
    elements["unredacted-ack"].disabled = elements.consent.disabled;
    renderSelectionCount(); updateDonateButton(); updateNavigation();
  }
}
function updateNavigation() {
  elements["sessions-prev"].disabled = state.busy || state.sessionPage === 0;
  elements["sessions-next"].disabled = state.busy || (state.sessionPage + 1) * 30 >= state.filtered.length;
  elements["messages-prev"].disabled = state.busy || state.messagePage === 0;
  elements["messages-next"].disabled = state.busy || (state.messagePage + 1) * 40 >= (state.preview?.sessions[0]?.messages.length || 0);
  const index = state.catalog.findIndex((s) => s.id === state.activeId);
  elements["review-prev"].disabled = state.busy || index <= 0;
  elements["review-next"].disabled = state.busy || index + 1 >= state.catalog.length;
  elements["review-position"].value = index + 1;
  elements["review-position"].max = state.catalog.length || 1;
  elements["review-total"].textContent = `of ${state.catalog.length} sessions`;
}
function previewOptions() {
  return { mode: state.mode, disabledKinds: [...state.disabledKinds], disabledMatches: [...state.disabledMatches] };
}
async function showSession(id) {
  if (state.busy || !id) return;
  state.activeId = id;
  const request = ++state.previewRequest, revision = state.revision;
  state.preview = null;
  // Keep the existing panel height and keyboard focus while the next session loads.
  elements["review-panel"].setAttribute("aria-busy", "true");
  elements["review-placeholder"].textContent = "Loading session…";
  elements["custom-status"].textContent = "";
  clearCustomError();
  highlightSession(); lockControls(state.busy);
  try {
    const index = state.review?.sessions?.findIndex((s) => s.id === id) ?? -1;
    const preview = state.review?.status === "ready" && index >= 0
      ? await api(`/api/reviews/${state.review.id}/sessions/${index}`)
      : await api("/api/donation-preview", "POST", { sessionIds: [id], ...previewOptions() });
    if (request !== state.previewRequest || revision !== state.revision) return;
    if (!preview.sessions.length) throw new Error("This session no longer has readable messages. Deselect it to continue.");
    state.reviewIndex = index; state.messagePage = 0; state.preview = preview;
    state.customRedactionCount = preview.customRedactionCount || 0;
    renderReview(); lockControls(state.busy);
    if (!state.updating && state.redactionFocus) {
      if (document.activeElement === document.body && state.activeId === state.redactionFocus.sessionId) {
        const control = [...elements.redactions.querySelectorAll("input")].find(input => input.dataset.redactionKey === state.redactionFocus.key);
        if (control) {
          control.closest("details").open = true;
          control.focus({ preventScroll: true });
        }
      }
      state.redactionFocus = null;
    }
  } catch (error) {
    if (request !== state.previewRequest || revision !== state.revision) return;
    setHidden(elements["review-content"], true); setHidden(elements["review-placeholder"], false);
    elements["review-placeholder"].textContent = `${error.message} Retry loading the preview, or choose another session.`;
    setHidden(elements["retry-preview"], false);
  } finally {
    if (request === state.previewRequest) elements["review-panel"].setAttribute("aria-busy", "false");
  }
}
function navigateReview(index) {
  if (state.busy || !Number.isInteger(index) || index < 0 || index >= state.catalog.length) return updateNavigation();
  const id = state.catalog[index].id;
  if (!state.filtered.some((s) => s.id === id)) { elements["session-search"].value = ""; state.filtered = state.catalog; }
  state.sessionPage = Math.floor(state.filtered.findIndex((s) => s.id === id) / 30);
  renderSessions(); void showSession(id);
}
function scheduleReview() {
  if (state.busy) return;
  clearTimeout(state.timer);
  state.revision++; state.updating = true; state.review = null;
  clearReview(); invalidateConsent(); renderMode(); lockControls(false);
  setHidden(elements["retry-preview"], true); setError();
  elements["progress"].textContent = state.chosen.size ? "Updating selected sessions…" : "No sessions selected for donation.";
  state.timer = setTimeout(() => void buildPreview(), 200);
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
async function buildPreview() {
  if (state.building || state.busy) return;
  state.building = true;
  let revision;
  try {
    do {
      revision = state.revision;
      const ids = [...state.chosen];
      state.updating = ids.length > 0;
      // Display just the active session while the full donation snapshot prepares.
      void showSession(state.activeId);
      if (!ids.length) { state.updating = false; lockControls(false); break; }
      let job = await api("/api/reviews", "POST", { sessionIds: ids, ...previewOptions() });
      while (job.status === "preparing" && revision === state.revision) {
        elements["progress"].textContent = `Preparing ${job.processed} of ${job.total} selected sessions…`;
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (revision === state.revision) job = await api(`/api/reviews/${job.id}`);
      }
      if (revision !== state.revision) {
        await api(`/api/reviews/${job.id}`, "DELETE");
        continue;
      }
      if (job.status !== "ready") throw new Error(job.error || "Could not prepare the review.");
      state.review = job; state.updating = false;
      elements["progress"].textContent = ""; setError();
      await showSession(state.activeId);
    } while (revision !== state.revision);
  } catch (error) {
    setError(error.message); state.updating = false;
    setHidden(elements["retry-preview"], false);
  } finally {
    state.building = false; lockControls(state.busy);
    if (revision !== state.revision) void buildPreview();
  }
}

function redactionCheckbox(item, match = null) {
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = match ? match.enabled : item.enabled;
  input.dataset.redactionKey = match ? `match:${match.id}` : `kind:${item.kind}`;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    state.redactionFocus = { key: input.dataset.redactionKey, sessionId: state.activeId };
    if (match && input.checked) {
      if (state.disabledKinds.delete(item.kind)) for (const other of item.matches) if (other.id !== match.id) state.disabledMatches.add(other.id);
      state.disabledMatches.delete(match.id);
    } else if (match) state.disabledMatches.add(match.id);
    else if (input.checked) {
      state.disabledKinds.delete(item.kind);
      for (const existing of item.matches) state.disabledMatches.delete(existing.id);
    } else state.disabledKinds.add(item.kind);
    scheduleReview();
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
    const label = document.createElement("span"); label.textContent = item.label;
    const count = document.createElement("b"); count.textContent = `${item.enabledCount}/${item.count}`;
    summary.append(label, count); details.append(summary);
    const matches = document.createElement("div"); matches.className = "matches";
    if (state.mode === "custom") {
      const category = document.createElement("label"); category.className = "redaction-category";
      category.append(redactionCheckbox(item), `Redact all ${item.label.toLowerCase()}`); matches.append(category);
    }
    for (const match of item.matches) {
      const row = document.createElement(state.mode === "custom" ? "label" : "div"); row.className = "match";
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
  const messages = state.review?.messages ?? state.catalog.reduce((sum, session) => sum + (state.chosen.has(session.id) ? session.messageCount : 0), 0);
  elements["session-inclusion"].textContent = state.chosen.has(state.activeId) ? "Included in donation" : "Not included in donation. Check its box on the left to include it.";
  if (state.mode === "unredacted") {
    elements.warning.className = "banner danger";
    elements.warning.textContent = "No automatic redactions are active. Credentials, personal details, code, URLs, and paths may be present.";
    elements["redaction-summary"].textContent = `${state.chosen.size} sessions · ${messages.toLocaleString()} messages selected.`;
  } else {
    elements.warning.className = "banner";
    elements.warning.textContent = `${state.preview.detectionCount} likely sensitive items removed in this session`;
    elements["redaction-summary"].textContent = `${state.chosen.size} sessions · ${messages.toLocaleString()} messages selected. Showing one session below.`;
    elements["redaction-summary"].className = "hint";
  }
  renderRedactions(); renderConversations(); renderMode(); updateDonateButton();
}

function clearCustomError() {
  elements["custom-error"].textContent = "";
  elements["custom-pattern"].removeAttribute("aria-invalid");
}

async function applyCustomRedaction() {
  if (state.busy || state.updating || state.review?.status !== "ready" || state.reviewIndex < 0 || state.mode !== "custom" || !state.preview || !state.chosen.has(state.activeId)) return;
  const pattern = elements["custom-pattern"].value;
  clearCustomError(); elements["custom-status"].textContent = "";
  if (!pattern) {
    elements["custom-error"].textContent = "Enter text or a regular expression.";
    elements["custom-pattern"].setAttribute("aria-invalid", "true");
    return elements["custom-pattern"].focus();
  }
  state.busy = true; invalidateConsent(); lockControls(true);
  try {
    const result = await api(`/api/reviews/${state.review.id}/sessions/${state.reviewIndex}`, "POST", { pattern, type: elements["custom-mode"].value });
    state.preview = result.preview;
    state.customRedactionCount = result.preview.customRedactionCount || 0;
    elements["custom-status"].textContent = result.count ? `Applied ${result.count} redaction${result.count === 1 ? "" : "s"}. Use Reset custom redactions for this session to undo.` : "No matches found. Try different text or a pattern.";
    if (result.count) elements["custom-pattern"].value = "";
    renderConversations(); renderMode();
  } catch (error) {
    elements["custom-error"].textContent = `${error.message} Check the text or pattern and try again.`;
    elements["custom-pattern"].setAttribute("aria-invalid", "true");
  } finally { state.busy = false; lockControls(false); elements["custom-pattern"].focus({ preventScroll: true }); }
}

async function resetCustomRedactions() {
  if (state.busy || state.updating || !state.preview || state.mode !== "custom" || state.review?.status !== "ready" || state.reviewIndex < 0) return;
  state.busy = true; invalidateConsent(); lockControls(true); clearCustomError();
  elements["custom-status"].textContent = "";
  try {
    const result = await api(`/api/reviews/${state.review.id}/sessions/${state.reviewIndex}`, "DELETE");
    state.preview = result.preview; state.customRedactionCount = result.preview.customRedactionCount || 0;
    renderReview();
    elements["custom-status"].textContent = "Custom redactions reset for this session. Automatic rules are unchanged.";
  } catch (error) { elements["custom-status"].textContent = `${error.message} Try resetting again.`; }
  finally { state.busy = false; lockControls(false); elements["reset-custom"].focus({ preventScroll: true }); }
}

async function donate() {
  if (state.busy || state.updating || !state.review || !state.chosen.size) return;
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
    elements["success-heading"].focus();
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
  renderSessions(); scheduleReview();
});
elements.mode.addEventListener("change", () => {
  state.mode = elements.mode.value; state.disabledKinds.clear(); state.disabledMatches.clear();
  scheduleReview();
});
elements["session-search"].addEventListener("input", () => {
  const query = elements["session-search"].value.trim().toLocaleLowerCase();
  state.filtered = state.catalog.filter((s) => `${s.title || ""} ${s.firstUserMessage || ""} ${s.agentName}`.toLocaleLowerCase().includes(query));
  state.sessionPage = 0; renderSessions();
});
elements["sessions-prev"].addEventListener("click", () => { state.sessionPage--; elements.sessions.scrollTop = 0; renderSessions(); });
elements["sessions-next"].addEventListener("click", () => { state.sessionPage++; elements.sessions.scrollTop = 0; renderSessions(); });
elements["review-prev"].addEventListener("click", () => navigateReview(state.catalog.findIndex((s) => s.id === state.activeId) - 1));
elements["review-next"].addEventListener("click", () => navigateReview(state.catalog.findIndex((s) => s.id === state.activeId) + 1));
elements["review-position"].addEventListener("change", () => navigateReview(Number(elements["review-position"].value) - 1));
elements["messages-prev"].addEventListener("click", () => { state.messagePage--; renderConversations(); });
elements["messages-next"].addEventListener("click", () => { state.messagePage++; renderConversations(); });
elements["close-app"].addEventListener("click", closeApp);
elements["reset-custom"].addEventListener("click", resetCustomRedactions);
elements["custom-pattern"].addEventListener("input", clearCustomError);
elements["retry-preview"].addEventListener("click", scheduleReview);
elements["apply-custom"].addEventListener("click", applyCustomRedaction);
elements.consent.addEventListener("change", updateDonateButton);
elements["unredacted-ack"].addEventListener("change", updateDonateButton);
elements.donate.addEventListener("click", donate);
elements["delete-donation"].addEventListener("click", deleteAcceptedDonation);

async function loadCatalog() {
  const retrying = document.activeElement === elements["retry-catalog"];
  elements["retry-catalog"].disabled = true;
  elements["loading-status"].textContent = "Loading local sessions…";
  try {
    const body = await api("/api/catalog");
    state.catalog = body.sessions; state.chosen = new Set(body.sessions.map((session) => session.id));
    setHidden(elements.loading, true);
    if (!state.catalog.length) {
      setHidden(elements.empty, false);
      if (retrying) { elements.empty.tabIndex = -1; elements.empty.focus(); }
      return;
    }
    state.filtered = state.catalog; state.activeId = state.catalog[0].id;
    setHidden(elements.workspace, false); renderSessions(); renderMode(); scheduleReview();
    if (retrying) elements["session-search"].focus();
  } catch (error) {
    elements["loading-status"].textContent = `${error.message} Retry loading sessions. If the local server has stopped, run share-with-susan-calvin again and open its new link.`;
    setHidden(elements["retry-catalog"], false); elements["retry-catalog"].disabled = false;
    if (retrying) elements["retry-catalog"].focus();
  }
}
elements["retry-catalog"].addEventListener("click", loadCatalog);
void loadCatalog();
