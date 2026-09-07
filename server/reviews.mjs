import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeDonationPreview, sessionSummary } from "./donation-preview.mjs";
import { sanitizeDonation } from "./donation-schema.mjs";
import { createRedactor } from "./custom-redaction.mjs";
import { REDACTION_KINDS } from "./privacy.mjs";

// Limits apply to one upload, never to the entire donation. Sessions stay intact.
export const BATCH_BYTES = 4_000_000;
export const SESSION_BYTES = 7_000_000;
export const MAX_REVIEW_SESSIONS = 100_000;
const byteLength = (value) => Buffer.byteLength(JSON.stringify(value));

export function planBatches(sessions) {
  const batches = [];
  let batch = [], bytes = 2_000;
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index];
    if (session.bytes > SESSION_BYTES || session.messageCount > 50_000) throw new Error("One session exceeds the supported size (7 MB or 50,000 messages). Deselect that entire session to continue.");
    if (batch.length && (bytes + session.bytes > BATCH_BYTES || batch.length === 250 || batch.reduce((n, i) => n + sessions[i].messageCount, 0) + session.messageCount > 50_000)) {
      batches.push(batch); batch = []; bytes = 2_000;
    }
    batch.push(index); bytes += session.bytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export class Reviews {
  constructor(catalog, { preview = makeDonationPreview, root = os.tmpdir() } = {}) { this.catalog = catalog; this.preview = preview; this.root = root; this.jobs = new Map(); this.customRedactions = []; }
  customRedactionCount() { return this.customRedactions.length; }
  async applyPatterns(preview, options, redactor) {
    preview.customDetectionCount = 0;
    if (options.mode === "custom") {
      for (const session of preview.sessions) {
        for (const rule of this.customRedactions) {
          const result = await redactor.redact(session.messages, rule.pattern, rule.type);
          session.messages = result.messages; preview.customDetectionCount += result.count;
        }
        if (this.customRedactions.length) session.summary = sessionSummary(session.messages);
      }
    }
    return { ...preview, customRedactionCount: this.customRedactionCount() };
  }
  async makePreview(ids, options) {
    const redactor = createRedactor();
    try { return await this.applyPatterns(await this.preview(this.catalog, ids, options), options, redactor); }
    finally { await redactor.close(); }
  }
  async create(ids, options) {
    if (!["standard", "custom", "unredacted"].includes(options.mode)) throw new Error("Choose a donation mode.");
    options = { ...options, unredacted: options.mode === "unredacted", disabledKinds: options.mode === "custom" ? options.disabledKinds || [] : [], disabledMatches: options.mode === "custom" ? options.disabledMatches || [] : [] };
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_REVIEW_SESSIONS || new Set(ids).size !== ids.length || ids.some((id) => !this.catalog.index.has(id))) throw new Error("Choose available sessions.");
    // Only one review snapshot is retained by this local server.
    if ([...this.jobs.values()].some((job) => ["preparing", "uploading"].includes(job.status) || job.redacting)) throw new Error("Wait for the current operation to finish.");
    await this.close();
    const folder = await fs.mkdtemp(path.join(this.root, "susan-calvin-review-"));
    await fs.chmod(folder, 0o700);
    const job = { id: crypto.randomUUID(), folder, status: "preparing", total: ids.length, processed: 0, sessions: [], messages: 0, detections: 0, customDetections: 0, redactions: REDACTION_KINDS.map(item => ({ ...item, count: 0, enabledCount: 0, enabled: !options.unredacted && !options.disabledKinds.includes(item.kind) })), options, uploaded: 0, donationId: "", error: "" };
    this.jobs.set(job.id, job);
    job.task = this.prepare(job, ids).catch((error) => { job.status = "error"; job.error = error.message; });
    return this.summary(job);
  }
  summary(job) {
    return { redacting: Boolean(job.redacting), redactedSessions: job.redactedSessions || 0, customError: job.customError || "", customCount: job.customCount || 0, id: job.id, status: job.status, total: job.total, processed: job.processed, ...(job.status === "ready" && !job.redacting ? { sessions: job.sessions } : {}), ...this.overview(job), uploaded: job.uploaded, batches: job.batches?.length || 0, donationId: job.donationId, error: job.error };
  }
  overview(job) { return { messages: job.messages, detections: job.detections, customDetections: job.customDetections, redactions: job.redactions, customRedactionCount: this.customRedactionCount() }; }
  countRedactions(job, preview, direction = 1) {
    for (const item of preview.redactions) {
      const total = job.redactions.find(total => total.kind === item.kind);
      if (total) { total.count += direction * item.count; total.enabledCount += direction * item.enabledCount; }
    }
    job.customDetections += direction * (preview.customDetectionCount || 0);
  }
  get(id) { const job = this.jobs.get(id); if (!job) throw new Error("Review expired. Prepare a new preview."); return job; }
  async prepare(job, ids) {
    const redactor = createRedactor();
    try {
      for (const id of ids) {
        if (job.cancelled) return;
        const base = await this.preview(this.catalog, [id], job.options);
        // Keep the automatic preview so resetting never rereads changed source files.
        await fs.writeFile(path.join(job.folder, `${job.sessions.length}.base.json`), JSON.stringify(base), { mode: 0o600, flag: "wx" });
        const preview = await this.applyPatterns(base, job.options, redactor);
        if (job.cancelled) return;
        if (preview.sessions.length !== 1) throw new Error("A selected session no longer contains readable messages. Refresh the session selection.");
        const session = preview.sessions[0];
        const bytes = byteLength({ source: session.source, messages: session.messages });
        planBatches([{ bytes, messageCount: session.messages.length }]);
        const index = job.sessions.length;
        await fs.writeFile(path.join(job.folder, `${index}.json`), JSON.stringify(preview), { mode: 0o600, flag: "wx" });
        this.countRedactions(job, preview);
        job.sessions.push({ id, label: session.label, summary: session.summary, source: session.source, bytes, messageCount: session.messages.length, detections: preview.detectionCount });
        job.messages += session.messages.length; job.detections += preview.detectionCount; job.processed++;
      }
      job.batches = planBatches(job.sessions);
      job.status = "ready";
    } finally { await redactor.close(); }
  }
  async cancel(job) {
    if (!["preparing", "ready", "error"].includes(job.status) || job.redacting) throw new Error("Wait for the current operation to finish.");
    job.cancelled = true;
    await job.task;
    job.status = "cancelled";
    await fs.rm(job.folder, { recursive: true, force: true });
    this.jobs.delete(job.id);
  }
  async read(job, index) {
    if (!Number.isInteger(index) || index < 0 || index >= job.sessions.length) throw new Error("Session not found.");
    return { ...JSON.parse(await fs.readFile(path.join(job.folder, `${index}.json`), "utf8")), customRedactionCount: this.customRedactionCount() };
  }
  async matches(job, kind, cancelled = () => false) {
    if (job.status !== "ready" || job.redacting) throw new Error("Wait for the preview to finish, then retry.");
    const category = job.redactions.find(item => item.kind === kind);
    if (!category) throw new Error("Choose an available redaction category.");
    // Read one snapshot at a time, only when a category is opened. Neither the
    // polling response nor the persistent job retains the donation's strings.
    const matches = new Map();
    for (let index = 0; category.count && index < job.sessions.length; index++) {
      if (cancelled() || job.cancelled) throw new Error("Review changed. Reopen the category.");
      const preview = await this.read(job, index);
      const item = preview.redactions.find(item => item.kind === kind);
      for (const match of item?.matches || []) {
        const existing = matches.get(match.id);
        if (existing) existing.count += match.count;
        else matches.set(match.id, { id: match.id, value: match.value, count: match.count, enabled: match.enabled });
      }
    }
    return { ...category, matches: [...matches.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)) };
  }
  async occurrence(job, kind, matchId, position = 0, cancelled = () => false) {
    if (job.status !== "ready" || job.redacting) throw new Error("Wait for the preview to finish, then retry.");
    if (!Number.isSafeInteger(position) || position < 0) throw new Error("Choose an available occurrence.");
    let total = 0, selected;
    for (let index = 0; index < job.sessions.length; index++) {
      if (cancelled() || job.cancelled) throw new Error("Review changed. Reopen the matched value.");
      const preview = await this.read(job, index);
      const match = preview.redactions.find(item => item.kind === kind)?.matches.find(match => match.id === matchId);
      if (!match) continue;
      if (position >= total && position < total + match.count) {
        const location = match.locations?.[position - total];
        if (location) selected = { ...location, value: match.value, enabled: match.enabled };
      }
      total += match.count;
    }
    if (!selected) throw new Error("Occurrence not found. Reopen the matched value.");
    return { ...selected, total, position };
  }
  async writeSession(job, index, preview, replan = true) {
    const previous = await this.read(job, index);
    const session = preview.sessions[0];
    const normalized = sanitizeDonation({ donationRunId: job.id, redactionMode: "standard", consent: { researchDonation: true }, sessions: [{ source: session.source, messages: session.messages }] });
    if (!normalized) throw new Error("Messages cannot be blank or exceed the supported size.");
    const bytes = byteLength(normalized.sessions[0]);
    planBatches([{ bytes, messageCount: session.messages.length }]);
    session.summary = sessionSummary(session.messages);
    const file = path.join(job.folder, `${index}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(preview), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    this.countRedactions(job, previous, -1); this.countRedactions(job, preview);
    job.messages += session.messages.length - job.sessions[index].messageCount;
    job.detections += preview.detectionCount - job.sessions[index].detections;
    job.sessions[index].messageCount = session.messages.length;
    job.sessions[index].detections = preview.detectionCount;
    job.sessions[index].bytes = bytes;
    job.sessions[index].summary = session.summary;
    if (replan) job.batches = planBatches(job.sessions);
  }
  async resetCustom(job) { return this.changeCustom(job, null); }
  async redact(job, rule) { return this.changeCustom(job, rule); }
  async changeCustom(job, rule) {
    if (job.status !== "ready" || job.redacting) throw new Error("Wait for the current operation to finish.");
    if (job.options.mode !== "custom") throw new Error("Choose Customize redactions to change custom redactions.");
    job.redacting = true; job.redactedSessions = 0; job.customError = ""; job.customCount = 0;
    const redactor = createRedactor();
    let folder;
    try {
      if (rule) await redactor.redact([], rule.pattern, rule.type);
      folder = await fs.mkdtemp(path.join(this.root, "susan-calvin-review-"));
      await fs.chmod(folder, 0o700);
      const staged = { ...job, folder, sessions: structuredClone(job.sessions), redactions: structuredClone(job.redactions) };
      let count = 0;
      // Commit only after every session succeeds. A bad pattern cannot leave a
      // donation partly redacted. Memory is bounded to one session at a time.
      for (let index = 0; index < job.sessions.length; index++) {
        await fs.copyFile(path.join(job.folder, `${index}.json`), path.join(folder, `${index}.json`));
        await fs.copyFile(path.join(job.folder, `${index}.base.json`), path.join(folder, `${index}.base.json`));
        const preview = rule ? await this.read(job, index) : JSON.parse(await fs.readFile(path.join(folder, `${index}.base.json`), "utf8"));
        if (rule) {
          const result = await redactor.redact(preview.sessions[0].messages, rule.pattern, rule.type);
          preview.sessions[0].messages = result.messages;
          preview.customDetectionCount = (preview.customDetectionCount || 0) + result.count;
          count += result.count;
        } else preview.customDetectionCount = 0;
        await this.writeSession(staged, index, preview, false);
        job.redactedSessions++;
      }
      staged.batches = planBatches(staged.sessions);
      const previousFolder = job.folder;
      for (const key of ["folder", "sessions", "messages", "detections", "customDetections", "redactions", "batches"]) job[key] = staged[key];
      folder = null;
      if (rule) this.customRedactions.push({ pattern: rule.pattern, type: rule.type });
      else this.customRedactions = [];
      job.customCount = count;
      await fs.rm(previousFolder, { recursive: true, force: true });
      return { count, overview: this.overview(job) };
    } finally {
      await redactor.close();
      if (folder) await fs.rm(folder, { recursive: true, force: true });
      job.redacting = false;
    }
  }
  async donation(job, indices, consent, version, batchIndex) {
    const sessions = [];
    let detections = 0;
    for (const index of indices) {
      const preview = await this.read(job, index);
      const session = preview.sessions[0];
      sessions.push({ source: session.source, messages: session.messages.map(({ role, text, timestamp }) => ({ role, text, ...(timestamp ? { timestamp } : {}) })) });
      detections += preview.detectionCount;
    }
    // Stable IDs make a retried upload idempotent, even after a lost response.
    const hex = crypto.createHash("sha256").update(`${job.id}:${batchIndex}`).digest("hex");
    const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return { donationRunId: runId, collector: { version }, group: { id: job.id, index: batchIndex, count: job.batches.length }, redactionMode: job.options.mode, createdAt: consent.consentedAt, consent, redactionSummary: { automatedDetections: detections }, sessions };
  }
  async close() {
    for (const job of this.jobs.values()) {
      await job.task;
      await job.customTask;
      await fs.rm(job.folder, { recursive: true, force: true });
    }
    this.jobs.clear();
  }
}
