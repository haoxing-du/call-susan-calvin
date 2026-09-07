import { splitCodexContext } from "./session-context.js";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const state = {
  catalog: [], chosen: new Set(), preview: null, mode: "standard", disabledKinds: new Set(), disabledMatches: new Map(),
  acceptedId: "", busy: false, review: null, sessionPage: 0, reviewIndex: 0, messagePage: 0,
  activeId: "", filtered: [], revision: 0, building: false, updating: false, previewRequest: 0, timer: null, customRedactionCount: 0, redactionFocus: null, categoryKind: "", categoryController: null, occurrence: null, occurrenceController: null, occurrenceLoading: false, occurrenceFocus: false,
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
  elements["review-placeholder"].textContent = state.activeId ? "Loading session…" : "";
}
function invalidateConsent() {
  elements.consent.checked = false;
  elements["unredacted-ack"].checked = false;
  updateDonateButton();
}
function updateDonateButton() {
  const messages = state.review?.messages || 0;
  const hasEmptyMessage = (state.preview?.sessions.some((session) => session.messages.some((message) => !message.text.trim())) || false);
  setHidden(elements["message-validation"], !hasEmptyMessage);
  elements.donate.disabled = state.busy || state.updating || state.review?.status !== "ready" || !state.chosen.size || !messages || (hasEmptyMessage && state.chosen.has(state.activeId)) || !elements.consent.checked || (state.mode === "unredacted" && !elements["unredacted-ack"].checked);
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
    copy.addEventListener("click", () => { elements["bundle-details"].open = false; void showSession(session.id); });
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
  elements["selection-count"].textContent = `${state.chosen.size} of ${state.catalog.length} included`;
  elements["select-all"].checked = state.chosen.size === state.catalog.length && state.catalog.length > 0;
  elements["select-all"].indeterminate = state.chosen.size > 0 && state.chosen.size < state.catalog.length;
}

function renderMode() {
  const descriptions = {
    standard: "",
    custom: "Uncheck a rule or value to leave it unredacted across all included sessions.",
    unredacted: "",
  };
  elements["mode-description"].textContent = descriptions[state.mode];
  elements["saved-redactions"].textContent = state.customRedactionCount ? state.mode === "custom"
    ? ""
    : "Custom redactions are paused. Choose Customize redactions to apply them." : "";
  setHidden(elements["custom-redaction"], state.mode !== "custom");
  setHidden(elements["unredacted-consent"], state.mode !== "unredacted");
  elements.donate.firstChild.textContent = state.mode === "unredacted" ? "Donate unredacted data " : "Donate reviewed data ";
}

async function api(url, method = "GET", body, signal) {
  const response = await fetch(url, { method, signal, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The local request failed.");
  return result;
}

function lockControls(locked) {
  for (const control of elements.workspace.querySelectorAll("input, select, button")) control.disabled = locked;
  if (!locked) {
    for (const control of elements["custom-redaction"].querySelectorAll("input, select, button")) control.disabled = state.updating || state.review?.status !== "ready" || !state.chosen.size;
    for (const control of elements["bundle-redactions"].querySelectorAll("button[data-custom-id]")) control.disabled = state.updating || state.review?.status !== "ready" || state.mode !== "custom";
    for (const control of elements["bundle-redactions"].querySelectorAll("input")) control.disabled = state.updating || state.review?.status !== "ready" || (control.dataset.redactionKey.startsWith("match:") && state.disabledKinds.has(control.dataset.kind));
    elements.consent.disabled = state.updating || !state.chosen.size || state.review?.status !== "ready";
    elements["unredacted-ack"].disabled = elements.consent.disabled;
    elements["occurrence-prev"].disabled = state.occurrenceLoading || !state.occurrence || state.occurrence.position <= 0;
    elements["occurrence-next"].disabled = state.occurrenceLoading || !state.occurrence || state.occurrence.position + 1 >= state.occurrence.total;
    elements["occurrence-redact"].disabled = state.updating || state.occurrenceLoading || state.disabledKinds.has(state.occurrence?.kind);
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
  return { mode: state.mode, disabledKinds: [...state.disabledKinds], disabledMatches: [...state.disabledMatches.keys()] };
}
async function showSession(id, occurrence = null) {
  if (state.busy || !id) return;
  state.activeId = id;
  state.occurrence = occurrence;
  if (!occurrence) { state.occurrenceController?.abort(); state.occurrenceLoading = false; }
  setHidden(elements["session-viewer"], false);
  setHidden(elements["back-overview"], false);
  const request = ++state.previewRequest, revision = state.revision;
  state.preview = null;
  // Keep the existing panel height and keyboard focus while the next session loads.
  elements["session-viewer"].setAttribute("aria-busy", "true");
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
    state.reviewIndex = index; state.messagePage = occurrence ? Math.floor(occurrence.messageIndex / 40) : 0; state.preview = preview;
    state.customRedactionCount = preview.customRedactionCount || 0;
    renderReview(); lockControls(state.busy);
    if (occurrence) {
      const target = elements["conversation-preview"].querySelector(".message-occurrence");
      if (target) elements["conversation-preview"].scrollTop = target.getBoundingClientRect().top - elements["conversation-preview"].getBoundingClientRect().top + elements["conversation-preview"].scrollTop - 8;
      elements[state.occurrenceFocus ? "occurrence-redact" : "occurrence-context"].focus({ preventScroll: true });
      state.occurrenceFocus = false;
    }
    restoreRedactionFocus();
  } catch (error) {
    if (request !== state.previewRequest || revision !== state.revision) return;
    setHidden(elements["review-content"], true); setHidden(elements["review-placeholder"], false);
    elements["review-placeholder"].textContent = `${error.message} Retry loading the preview, or choose another session.`;
    setHidden(elements["retry-preview"], false);
  } finally {
    if (request === state.previewRequest) elements["session-viewer"].setAttribute("aria-busy", "false");
  }
}
function restoreRedactionFocus() {
  if (state.updating || !state.redactionFocus) return;
  if (document.activeElement === document.body && (state.redactionFocus.key.startsWith("kind:") || state.redactionFocus.key.startsWith("match:"))) {
    const control = [...elements["review-panel"].querySelectorAll("input[data-redaction-key]")].find(input => input.dataset.redactionKey === state.redactionFocus.key);
    if (control) {
      const details = control.closest("details"); if (details) details.open = true;
      control.focus({ preventScroll: true });
    }
  }
  if (!state.categoryController) state.redactionFocus = null;
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
  state.occurrenceController?.abort(); state.occurrenceLoading = false;
  state.revision++; state.updating = true; state.review = null;
  clearReview(); invalidateConsent(); renderMode(); renderOverview(); lockControls(false);
  setHidden(elements["retry-preview"], true); setError();
  elements["progress"].textContent = state.chosen.size ? "Updating included sessions…" : "No sessions included in donation.";
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
      if (!state.occurrence) void showSession(state.activeId);
      if (!ids.length) { state.updating = false; lockControls(false); break; }
      let job = await api("/api/reviews", "POST", { sessionIds: ids, ...previewOptions() });
      while (job.status === "preparing" && revision === state.revision) {
        elements["progress"].textContent = `Preparing ${job.processed} of ${job.total} included sessions…`;
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (revision === state.revision) job = await api(`/api/reviews/${job.id}`);
      }
      if (revision !== state.revision) {
        await api(`/api/reviews/${job.id}`, "DELETE");
        continue;
      }
      if (job.status !== "ready") throw new Error(job.error || "Could not prepare the review.");
      state.review = job; state.updating = false;
      state.customRedactionCount = job.customRedactionCount || 0;
      renderOverview(); renderMode();
      elements["progress"].textContent = ""; setError();
      if (state.occurrence) await openOccurrence(state.occurrence.kind, state.occurrence.matchId, state.occurrence.position);
      else await showSession(state.activeId);
      restoreRedactionFocus();
    } while (revision !== state.revision);
  } catch (error) {
    setError(error.message); state.updating = false;
    renderOverview();
    setHidden(elements["retry-preview"], false);
  } finally {
    state.building = false; lockControls(state.busy);
    if (revision !== state.revision) void buildPreview();
  }
}

function redactionCheckbox(item, match = null) {
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = match ? match.enabled : item.enabled;
  input.dataset.redactionKey = match ? `match:${match.id}` : `kind:${item.kind}`;
  input.dataset.kind = item.kind;
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("change", () => {
    state.redactionFocus = { key: input.dataset.redactionKey, sessionId: state.activeId };
    if (match && input.checked) {
      state.disabledMatches.delete(match.id);
    } else if (match) state.disabledMatches.set(match.id, item.kind);
    else if (input.checked) {
      state.disabledKinds.delete(item.kind);
      for (const [id, kind] of state.disabledMatches) if (kind === item.kind) state.disabledMatches.delete(id);
    } else state.disabledKinds.add(item.kind);
    scheduleReview();
  });
  return input;
}

async function loadCategory(item, container) {
  state.categoryController?.abort();
  const controller = new AbortController(); state.categoryController = controller;
  container.textContent = "Loading matches…";
  const status = document.createElement("p"); status.className = "hint"; status.setAttribute("role", "status");
  try {
    const result = await api(`/api/reviews/${state.review.id}/redactions/${item.kind}`, "GET", null, controller.signal);
    if (controller.signal.aborted || !container.isConnected) return;
    container.replaceChildren();
    if (!result.matches.length) { status.textContent = "No matches in included sessions."; container.append(status); }
    for (const match of result.matches) {
      const row = document.createElement("div"); row.className = "match";
      if (state.mode === "custom") {
        const input = redactionCheckbox(item, match); input.setAttribute("aria-label", `Redact ${match.value}`); row.append(input);
      }
      const code = document.createElement("button"); code.className = "match-open"; code.textContent = match.value;
      code.setAttribute("aria-label", `View occurrences of ${match.value}`);
      code.addEventListener("click", () => void openOccurrence(item.kind, match.id));
      const count = document.createElement("span"); count.className = "match-count";
      count.textContent = `${match.count.toLocaleString()}×${match.enabled ? "" : " · Not redacted"}`;
      row.append(code, count); container.append(row);
    }
    lockControls(state.busy);
  } catch (error) {
    if (controller.signal.aborted || !container.isConnected) return;
    container.replaceChildren(); status.textContent = "Unable to load matches.";
    const retry = document.createElement("button"); retry.className = "secondary"; retry.textContent = "Retry loading matches";
    retry.addEventListener("click", () => void loadCategory(item, container));
    container.append(status, retry);
  } finally {
    if (state.categoryController === controller) { state.categoryController = null; restoreRedactionFocus(); }
  }
}

async function openOccurrence(kind, matchId, position = 0) {
  if (state.busy || state.updating || state.review?.status !== "ready") return;
  state.occurrenceController?.abort();
  const controller = new AbortController(); state.occurrenceController = controller; state.occurrenceLoading = true;
  const reviewId = state.review.id;
  elements["occurrence-error"].textContent = ""; setError(); lockControls(false);
  try {
    const result = await api(`/api/reviews/${reviewId}/redactions/${kind}/${matchId}?position=${position}`, "GET", null, controller.signal);
    if (controller.signal.aborted || state.review?.id !== reviewId) return;
    elements["bundle-details"].open = false; elements["custom-redaction"].open = false;
    // Reveal the location's catalog page without changing donation inclusion.
    if (!state.filtered.some(s => s.id === result.sessionId)) { elements["session-search"].value = ""; state.filtered = state.catalog; }
    state.sessionPage = Math.floor(state.filtered.findIndex(s => s.id === result.sessionId) / 30);
    await showSession(result.sessionId, { ...result, kind, matchId }); renderSessions();
  } catch (error) {
    if (!controller.signal.aborted && state.review?.id === reviewId) {
      state.occurrence = null; setHidden(elements.occurrence, true);
      setError(`${error.message} Click the matched value to retry.`);
    }
  } finally {
    if (state.occurrenceController === controller) { state.occurrenceController = null; state.occurrenceLoading = false; lockControls(state.busy); }
  }
}

function renderOccurrence() {
  const match = state.occurrence;
  setHidden(elements.occurrence, !match);
  if (!match) return;
  elements["occurrence-position"].textContent = `${match.position + 1} of ${match.total}`;
  elements["occurrence-label"].textContent = `Message ${match.messageIndex + 1} · Match context (local only)`;
  const marked = document.createElement("mark"); marked.textContent = match.value;
  elements["occurrence-context"].replaceChildren(match.before, marked, match.after);
  elements["occurrence-redact"].checked = match.enabled;
  setHidden(elements["occurrence-toggle"], state.mode !== "custom");
}

function renderConversations() {
  elements["conversation-preview"].replaceChildren();
  state.preview.sessions.forEach((session, sessionIndex) => {
    const details = document.createElement("details"); details.className = "conversation"; if (sessionIndex === 0) details.open = true;
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    const strong = document.createElement("strong"); strong.textContent = state.catalog.find(item => item.id === session.sessionId)?.title || session.label;
    const small = document.createElement("small"); small.textContent = session.summary;
    const count = document.createElement("b"); count.textContent = `${session.messages.length} messages`;
    title.append(strong, small); summary.append(title, count); details.append(summary);
    const messages = document.createElement("div"); messages.className = "messages";
    session.messages.slice(state.messagePage * 40, (state.messagePage + 1) * 40).forEach((message, pageIndex) => {
      const matched = state.occurrence?.messageIndex === state.messagePage * 40 + pageIndex;
      const parts = session.source === "codex" && message.role === "user" ? splitCodexContext(message.text) : { context: "", text: message.text };
      const transcript = (part, label) => {
        const text = document.createElement("pre"); text.className = "transcript-text";
        text.textContent = parts[part]; text.setAttribute("aria-label", label); text.tabIndex = 0;
        return text;
      };
      if (parts.context) {
        const context = document.createElement("details"); context.className = `message-context${matched ? " message-occurrence" : ""}`; if (matched) context.open = true;
        const heading = document.createElement("summary"); heading.textContent = "Codex context · included in donation";
        context.append(heading, transcript("context", "Codex context")); messages.append(context);
      }
      if (parts.text || !parts.context) {
        const row = document.createElement("div"); row.className = `message ${message.role === "user" ? "message-user" : "message-agent"}${matched ? " message-occurrence" : ""}`;
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

function renderOverview() {
  const ready = !state.updating && state.review?.status === "ready";
  setHidden(elements["bundle-overview"], !ready);
  state.categoryController?.abort(); state.categoryController = null;
  elements["bundle-redactions"].replaceChildren();
  elements["bundle-status"].textContent = !state.chosen.size ? "Include a session to review redactions."
    : !ready ? state.updating ? "Preparing redactions…" : "Unable to prepare redactions. Retry loading the preview." : "";
  if (!ready) return;
  const job = state.review;
  const total = job.detections + (job.customDetections || 0);
  elements["redaction-summary"].textContent = `${job.total.toLocaleString()} sessions · ${job.messages.toLocaleString()} messages`;
  if (state.mode === "unredacted") {
    elements.warning.className = "banner danger";
    elements.warning.textContent = "No redactions are applied to this donation. Credentials, personal details, code, URLs, and paths may be present.";
  } else {
    elements.warning.className = "banner";
    elements.warning.textContent = `${total.toLocaleString()} redaction${total === 1 ? "" : "s"}`;
  }
  const table = document.createElement("table"); table.className = "bundle-redactions";
  const head = document.createElement("thead"), headers = document.createElement("tr");
  for (const text of ["Redaction", "Status", "Instances"]) {
    const th = document.createElement("th"); th.scope = "col"; th.textContent = text; headers.append(th);
  }
  head.append(headers); table.append(head);
  const body = document.createElement("tbody");
  const groupHeading = label => {
    const row = document.createElement("tr"), heading = document.createElement("th");
    heading.colSpan = 3; heading.className = "redaction-group"; heading.textContent = label;
    row.append(heading); body.append(row);
  };
  groupHeading("Standard redactions");
  for (const item of job.redactions || []) {
    const row = document.createElement("tr"), name = document.createElement("th"); name.scope = "row";
    const heading = document.createElement("div"); heading.className = "category-heading";
    if (state.mode === "custom") {
      const input = redactionCheckbox(item); input.setAttribute("aria-label", `Redact ${item.label.toLocaleLowerCase()}`); heading.append(input);
    }
    const toggle = document.createElement("button"); toggle.className = "category-toggle";
    toggle.textContent = item.label; toggle.setAttribute("aria-expanded", String(state.categoryKind === item.kind));
    toggle.setAttribute("aria-controls", `matches-${item.kind}`);
    const detailRow = document.createElement("tr"); setHidden(detailRow, state.categoryKind !== item.kind);
    const cell = document.createElement("td"); cell.colSpan = 3;
    const matches = document.createElement("div"); matches.className = "matches category-matches"; matches.id = `matches-${item.kind}`;
    matches.setAttribute("role", "region"); matches.setAttribute("aria-label", `${item.label} across included sessions`); matches.tabIndex = 0;
    cell.append(matches); detailRow.append(cell);
    toggle.addEventListener("click", () => {
      state.categoryKind = state.categoryKind === item.kind ? "" : item.kind;
      renderOverview();
      elements["bundle-redactions"].querySelector(`[aria-controls="matches-${item.kind}"]`)?.focus({ preventScroll: true });
    });
    heading.append(toggle); name.append(heading);
    const status = document.createElement("td"); status.textContent = !item.enabled ? "Off" : item.enabledCount < item.count ? "Some excluded" : "On";
    const count = document.createElement("td"); count.textContent = item.count > item.enabledCount ? `${item.enabledCount.toLocaleString()} of ${item.count.toLocaleString()}` : item.enabledCount.toLocaleString();
    row.append(name, status, count); body.append(row, detailRow);
    if (state.categoryKind === item.kind) queueMicrotask(() => { if (matches.isConnected) void loadCategory(item, matches); });
  }
  if (state.mode === "custom" || job.customRules?.length) {
    groupHeading("Custom redactions");
    for (const rule of job.customRules || []) {
      const row = document.createElement("tr"), name = document.createElement("th"); name.scope = "row";
      const pattern = document.createElement("code"); pattern.className = "custom-rule-pattern"; pattern.textContent = rule.pattern;
      const type = document.createElement("span"); type.className = "custom-rule-type"; type.textContent = rule.type === "regex" ? "Regular expression" : "Plain text";
      name.append(pattern, type);
      const status = document.createElement("td"); status.append(rule.enabled ? "On" : "Off");
      if (state.mode === "custom") {
        const remove = document.createElement("button"); remove.className = "remove-custom"; remove.textContent = "Remove"; remove.dataset.customId = rule.id;
        remove.setAttribute("aria-label", `Remove custom redaction: ${rule.pattern}`);
        remove.addEventListener("click", () => { void changeCustomRedactions(false, rule.id); });
        status.append(remove);
      }
      const count = document.createElement("td"); count.textContent = rule.count.toLocaleString();
      row.append(name, status, count); body.append(row);
    }
    if (!job.customRules?.length) {
      const row = document.createElement("tr"), empty = document.createElement("td"); empty.colSpan = 3; empty.className = "custom-rules-empty"; empty.textContent = "No custom redactions added.";
      row.append(empty); body.append(row);
    }
  }
  table.append(body); elements["bundle-redactions"].append(table);
  lockControls(state.busy);
}

function renderReview() {
  setHidden(elements["review-placeholder"], true); setHidden(elements["review-content"], false);
  const count = state.preview.detectionCount + (state.preview.customDetectionCount || 0);
  elements["session-redaction-summary"].textContent = `${state.chosen.has(state.activeId) ? "Included" : "Not included"} · ${count.toLocaleString()} redaction${count === 1 ? "" : "s"}`;
  renderOccurrence(); renderConversations(); renderMode(); updateDonateButton();
}

function clearCustomError() {
  elements["custom-error"].textContent = "";
  elements["custom-pattern"].removeAttribute("aria-invalid");
}

async function changeCustomRedactions(reset = false, removeId = "") {
  if (state.busy || state.updating || state.review?.status !== "ready" || state.mode !== "custom" || !state.chosen.size) return;
  const pattern = elements["custom-pattern"].value;
  clearCustomError();
  if (!reset && !removeId && !pattern) {
    elements["custom-error"].textContent = "Enter text or a regular expression.";
    elements["custom-pattern"].setAttribute("aria-invalid", "true");
    return elements["custom-pattern"].focus();
  }
  state.occurrenceController?.abort(); state.occurrenceLoading = false;
  state.categoryController?.abort(); state.categoryKind = ""; state.previewRequest++;
  state.busy = true; invalidateConsent(); lockControls(true);
  try {
    const removing = reset || Boolean(removeId);
    let result = await api(`/api/reviews/${state.review.id}/custom${removeId ? `/${removeId}` : ""}`, removing ? "DELETE" : "POST", removing ? undefined : { pattern, type: elements["custom-mode"].value });
    while (result.redacting) {
      elements["custom-status"].textContent = `${removing ? "Updating" : "Redacting"} ${result.redactedSessions.toLocaleString()} of ${result.total.toLocaleString()} sessions…`;
      await new Promise(resolve => setTimeout(resolve, 300));
      result = await api(`/api/reviews/${state.review.id}`);
    }
    if (result.customError) throw new Error(result.customError);
    state.review = result; state.customRedactionCount = result.customRedactionCount || 0;
    if (state.activeId) {
      const index = state.review.sessions.findIndex(session => session.id === state.activeId);
      state.preview = index >= 0 ? await api(`/api/reviews/${state.review.id}/sessions/${index}`) : await api("/api/donation-preview", "POST", { sessionIds: [state.activeId], ...previewOptions() });
      state.occurrence = null;
      renderReview();
    }
    elements["bundle-details"].open = true;
    renderOverview(); renderMode();
    elements["custom-status"].textContent = removeId ? "Custom redaction removed." : reset ? "Custom redactions reset across all included sessions." : result.customCount ? `Applied ${result.customCount.toLocaleString()} redaction${result.customCount === 1 ? "" : "s"} across included sessions.` : "No matches found. Pattern saved for sessions you include later.";
    if (!reset && !removeId) elements["custom-pattern"].value = "";
  } catch (error) {
    elements["custom-status"].textContent = "";
    elements["custom-error"].textContent = error.message;
    if (!reset && !removeId) elements["custom-pattern"].setAttribute("aria-invalid", "true");
  } finally {
    state.busy = false; lockControls(false);
    if (removeId) {
      const next = elements["bundle-redactions"].querySelector("button[data-custom-id]");
      (next || elements["custom-pattern"]).focus({ preventScroll: true });
    } else elements[reset ? "reset-custom" : "custom-pattern"].focus({ preventScroll: true });
  }
}

async function applyCustomRedaction() { return changeCustomRedactions(); }
async function resetCustomRedactions() { return changeCustomRedactions(true); }

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
  state.mode = elements.mode.value;
  if (state.mode === "custom") elements["custom-redaction"].open = true;
  if (state.mode === "unredacted") state.occurrence = null;
  state.disabledKinds.clear(); state.disabledMatches.clear();
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
elements["messages-prev"].addEventListener("click", () => { state.messagePage--; state.occurrence = null; renderOccurrence(); renderConversations(); });
elements["messages-next"].addEventListener("click", () => { state.messagePage++; state.occurrence = null; renderOccurrence(); renderConversations(); });
elements["close-app"].addEventListener("click", closeApp);
elements["back-overview"].addEventListener("click", () => {
  state.activeId = ""; state.preview = null; state.previewRequest++; state.occurrence = null; state.occurrenceController?.abort();
  elements["session-viewer"].setAttribute("aria-busy", "false");
  setHidden(elements["session-viewer"], true);
  elements["bundle-details"].open = true;
  setHidden(elements["review-content"], true); setHidden(elements["review-placeholder"], false); setHidden(elements["back-overview"], true);
  elements["review-placeholder"].textContent = "";
  highlightSession(); renderMode(); lockControls(state.busy);
  elements["review-heading"].focus({ preventScroll: true });
});
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
    state.filtered = state.catalog; state.activeId = "";
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

elements["occurrence-prev"].addEventListener("click", () => { if (state.occurrence) void openOccurrence(state.occurrence.kind, state.occurrence.matchId, state.occurrence.position - 1); });
elements["occurrence-next"].addEventListener("click", () => { if (state.occurrence) void openOccurrence(state.occurrence.kind, state.occurrence.matchId, state.occurrence.position + 1); });
elements["occurrence-redact"].addEventListener("change", () => {
  const match = state.occurrence;
  if (!match) return;
  state.occurrenceFocus = true;
  if (elements["occurrence-redact"].checked) state.disabledMatches.delete(match.matchId);
  else state.disabledMatches.set(match.matchId, match.kind);
  scheduleReview();
});
