import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeDonationPreview } from "./donation-preview.mjs";
import { sanitizeDonation } from "./donation-schema.mjs";

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
  constructor(catalog, { preview = makeDonationPreview, root = os.tmpdir() } = {}) { this.catalog = catalog; this.preview = preview; this.root = root; this.jobs = new Map(); }
  async create(ids, options) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_REVIEW_SESSIONS || new Set(ids).size !== ids.length || ids.some((id) => !this.catalog.index.has(id))) throw new Error("Choose available sessions.");
    // Only one review snapshot is retained by this local server.
    if ([...this.jobs.values()].some((job) => ["preparing", "uploading"].includes(job.status))) throw new Error("Wait for the current operation to finish.");
    await this.close();
    const folder = await fs.mkdtemp(path.join(this.root, "susan-calvin-review-"));
    await fs.chmod(folder, 0o700);
    const job = { id: crypto.randomUUID(), folder, status: "preparing", total: ids.length, processed: 0, sessions: [], messages: 0, detections: 0, options, uploaded: 0, donationId: "", error: "" };
    this.jobs.set(job.id, job);
    job.task = this.prepare(job, ids).catch((error) => { job.status = "error"; job.error = error.message; });
    return this.summary(job);
  }
  summary(job) {
    return { id: job.id, status: job.status, total: job.total, processed: job.processed, ...(job.status === "ready" ? { sessions: job.sessions } : {}), messages: job.messages, detections: job.detections, uploaded: job.uploaded, batches: job.batches?.length || 0, donationId: job.donationId, error: job.error };
  }
  get(id) { const job = this.jobs.get(id); if (!job) throw new Error("Review expired. Prepare a new preview."); return job; }
  async prepare(job, ids) {
    for (const id of ids) {
      const preview = await this.preview(this.catalog, [id], job.options);
      if (preview.sessions.length !== 1) throw new Error("A selected session no longer contains readable messages. Refresh the session selection.");
      const session = preview.sessions[0];
      const bytes = byteLength({ source: session.source, messages: session.messages });
      planBatches([{ bytes, messageCount: session.messages.length }]);
      const index = job.sessions.length;
      await fs.writeFile(path.join(job.folder, `${index}.json`), JSON.stringify(preview), { mode: 0o600, flag: "wx" });
      job.sessions.push({ id, label: session.label, summary: session.summary, source: session.source, bytes, messageCount: session.messages.length, detections: preview.detectionCount });
      job.messages += session.messages.length; job.detections += preview.detectionCount; job.processed++;
    }
    job.batches = planBatches(job.sessions);
    job.status = "ready";
  }
  async read(job, index) {
    if (!Number.isInteger(index) || index < 0 || index >= job.sessions.length) throw new Error("Session not found.");
    return JSON.parse(await fs.readFile(path.join(job.folder, `${index}.json`), "utf8"));
  }
  async edit(job, index, messages) {
    if (job.status !== "ready") throw new Error("The review cannot be edited during upload.");
    const preview = await this.read(job, index);
    const original = preview.sessions[0];
    if (!Array.isArray(messages) || messages.length !== original.messages.length || messages.some((m, i) => m.role !== original.messages[i].role || m.timestamp !== original.messages[i].timestamp)) throw new Error("Keep every message and its original order.");
    const normalized = sanitizeDonation({ donationRunId: job.id, redactionMode: "standard", consent: { researchDonation: true }, sessions: [{ source: original.source, messages }] });
    if (!normalized) throw new Error("Messages cannot be blank or exceed the supported size.");
    const bytes = byteLength(normalized.sessions[0]);
    planBatches([{ bytes, messageCount: messages.length }]);
    // Keep the exact reviewed text. Normalization happens only at encryption.
    original.messages = messages;
    const file = path.join(job.folder, `${index}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify(preview), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    job.sessions[index].bytes = bytes;
    job.batches = planBatches(job.sessions);
  }
  async donation(job, indices, consent, version, batchIndex) {
    const sessions = [];
    let detections = 0;
    for (const index of indices) {
      const preview = await this.read(job, index);
      const session = preview.sessions[0];
      sessions.push({ source: session.source, messages: session.messages.map(({ role, text, timestamp }) => ({ role, text, ...(consent.timestamps && timestamp ? { timestamp } : {}) })) });
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
      await fs.rm(job.folder, { recursive: true, force: true });
    }
    this.jobs.clear();
  }
}
