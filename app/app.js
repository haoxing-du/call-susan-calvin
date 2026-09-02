const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const state = {
  catalog: [], chosen: new Set(), preview: null, mode: "standard", disabledKinds: new Set(), disabledMatches: new Set(),
  donationRunId: crypto.randomUUID(), acceptedId: "", busy: false,
};

function setHidden(element, hidden) { element.classList.toggle("hidden", hidden); }
function formatBytes(value) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : `${Math.ceil(value / 1_000)} KB`; }
function setError(message = "") { elements.error.textContent = message; }
function clearReview() {
  state.preview = null;
  setHidden(elements["review-placeholder"], false);
  setHidden(elements["review-content"], true);
  elements["preview-button"].textContent = "Build review";
}
function invalidateConsent() {
  elements.consent.checked = false;
  elements["unredacted-ack"].checked = false;
  state.donationRunId = crypto.randomUUID();
  updateDonateButton();
}
function updateDonateButton() {
  const messages = state.preview?.sessions.reduce((sum, session) => sum + session.messages.length, 0) || 0;
  elements.donate.disabled = state.busy || !messages || !elements.consent.checked || (state.mode === "unredacted" && !elements["unredacted-ack"].checked);
}

function renderSessions() {
  elements.sessions.replaceChildren();
  for (const session of state.catalog) {
    const label = document.createElement("label"); label.className = "session";
    const input = document.createElement("input"); input.type = "checkbox"; input.checked = state.chosen.has(session.id);
    input.addEventListener("change", () => { input.checked ? state.chosen.add(session.id) : state.chosen.delete(session.id); clearReview(); invalidateConsent(); renderSelectionCount(); });
    const copy = document.createElement("span");
    const strong = document.createElement("strong"); strong.textContent = `${session.agentName} · ${new Date(session.startedAt).toLocaleDateString()}`;
    const small = document.createElement("small"); small.textContent = `${session.messageCount} messages · ${formatBytes(session.sizeBytes)}`;
    copy.append(strong, small); label.append(input, copy); elements.sessions.append(label);
  }
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
    standard: "Automatically removes high-confidence credentials and common personal identifiers. You still review every line.",
    custom: "Choose automatic redactions and add plain-text or regular-expression replacements before donating.",
    unredacted: "Disables automatic redaction. Every included line must be reviewed, and an additional acknowledgement is required.",
  };
  elements["mode-description"].textContent = descriptions[state.mode];
  setHidden(elements["custom-redaction"], state.mode !== "custom" || !state.preview);
  setHidden(elements["unredacted-consent"], state.mode !== "unredacted");
  elements.donate.firstChild.textContent = state.mode === "unredacted" ? "Donate unredacted data " : "Donate reviewed data ";
}

async function buildPreview() {
  state.busy = true; setError(); invalidateConsent(); renderSelectionCount();
  elements["preview-button"].textContent = "Building local review…";
  try {
    const response = await fetch("/api/donation-preview", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: [...state.chosen], mode: state.mode, disabledKinds: [...state.disabledKinds], disabledMatches: [...state.disabledMatches] }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Could not build the review.");
    state.preview = body;
    renderReview();
  } catch (error) { setError(error.message); }
  finally { state.busy = false; elements["preview-button"].textContent = "Rebuild review"; renderSelectionCount(); updateDonateButton(); }
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
    void buildPreview();
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

function removeMessage(sessionIndex, messageIndex) {
  state.preview.sessions[sessionIndex].messages.splice(messageIndex, 1);
  if (!state.preview.sessions[sessionIndex].messages.length) state.preview.sessions.splice(sessionIndex, 1);
  invalidateConsent(); renderConversations();
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
    session.messages.forEach((message, messageIndex) => {
      const row = document.createElement("div"); row.className = "message";
      const role = document.createElement("span"); role.textContent = message.role === "assistant" ? "Agent" : "You";
      const textarea = document.createElement("textarea"); textarea.value = message.text; textarea.setAttribute("aria-label", `${role.textContent} message`);
      textarea.addEventListener("input", () => { message.text = textarea.value; invalidateConsent(); });
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Exclude"; remove.addEventListener("click", () => removeMessage(sessionIndex, messageIndex));
      row.append(role, textarea, remove); messages.append(row);
    });
    details.append(messages); elements["conversation-preview"].append(details);
  });
}

function renderReview() {
  setHidden(elements["review-placeholder"], true); setHidden(elements["review-content"], false);
  const messages = state.preview.sessions.reduce((sum, session) => sum + session.messages.length, 0);
  if (state.mode === "unredacted") {
    elements.warning.className = "banner danger";
    elements.warning.textContent = "No automatic redactions are active. Credentials, personal details, code, URLs, and paths may be present.";
    elements["redaction-summary"].replaceChildren();
  } else {
    elements.warning.className = "banner";
    elements.warning.textContent = `${state.preview.detectionCount} likely sensitive items removed locally`;
    elements["redaction-summary"].textContent = `${state.preview.sessions.length} sessions · ${messages} messages`;
    elements["redaction-summary"].className = "hint";
  }
  renderRedactions(); renderConversations(); renderMode(); updateDonateButton();
}

function applyCustomRedaction() {
  const pattern = elements["custom-pattern"].value;
  const replacement = elements["custom-replacement"].value.trim() || "[REDACTED CUSTOM]";
  if (!pattern) return elements["custom-status"].textContent = "Enter text or a regular expression.";
  let expression;
  try { expression = elements["custom-mode"].value === "regex" ? new RegExp(pattern, "giu") : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu"); }
  catch (error) { return elements["custom-status"].textContent = `Invalid expression: ${error.message}`; }
  if (expression.test("")) return elements["custom-status"].textContent = "The expression cannot match an empty string.";
  let count = 0;
  for (const session of state.preview.sessions) for (const message of session.messages) {
    expression.lastIndex = 0;
    message.text = message.text.replace(expression, () => { count++; return replacement; });
  }
  elements["custom-status"].textContent = count ? `Applied ${count} replacement${count === 1 ? "" : "s"}. Rebuild the review to undo.` : "No matches found.";
  if (count) { elements["custom-pattern"].value = ""; invalidateConsent(); renderConversations(); }
}

async function donate() {
  state.busy = true; setError(); updateDonateButton();
  const includeTimestamps = elements.timestamps.checked;
  const donation = {
    donationRunId: state.donationRunId,
    redactionMode: state.mode,
    createdAt: new Date().toISOString(),
    redactionSummary: { automatedDetections: state.preview.detectionCount },
    sessions: state.preview.sessions.map((session) => ({ source: session.source, messages: session.messages.map((message) => ({ role: message.role, text: message.text, ...(includeTimestamps && message.timestamp ? { timestamp: message.timestamp } : {}) })) })),
    consent: { researchDonation: true, ...(state.mode === "unredacted" ? { unredactedData: true } : {}), consentedAt: new Date().toISOString() },
  };
  try {
    const response = await fetch("/api/donations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ donation }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "Donation failed.");
    state.acceptedId = body.donationId;
    elements["donation-id"].textContent = state.acceptedId;
    elements["delete-donation"].classList.toggle("hidden", !/^[0-9a-f-]{36}$/.test(state.acceptedId));
    setHidden(elements.workspace, true); setHidden(elements.success, false);
  } catch (error) { setError(error.message); }
  finally { state.busy = false; updateDonateButton(); }
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
  state.mode = elements.mode.value; state.disabledKinds.clear(); state.disabledMatches.clear();
  clearReview(); invalidateConsent(); renderMode();
});
elements["preview-button"].addEventListener("click", buildPreview);
elements["apply-custom"].addEventListener("click", applyCustomRedaction);
elements.timestamps.addEventListener("change", invalidateConsent);
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
