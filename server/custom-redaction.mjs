import { Worker, isMainThread, parentPort } from "node:worker_threads";

// Reuse one worker for a bundle, but time-limit each session independently.
export function createRedactor() {
  const worker = new Worker(new URL(import.meta.url));
  let pending, stopped = false;
  function fail(error) {
    stopped = true;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; }
    void worker.terminate();
  }
  worker.on("error", fail);
  worker.on("exit", () => { if (pending) fail(new Error("Redaction stopped. Try a simpler expression.")); });
  worker.on("message", result => {
    const current = pending; pending = null;
    if (!current) return;
    clearTimeout(current.timer);
    if (result.error) current.reject(new Error(result.error)); else current.resolve(result);
  });
  return {
    redact(messages, pattern, type) {
      if (typeof pattern !== "string" || !pattern.length || pattern.length > 200 || !["text", "regex"].includes(type)) throw new Error("Enter text or a regular expression of up to 200 characters.");
      if (stopped || pending) throw new Error("Redaction is unavailable. Try again.");
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => fail(new Error("This pattern took too long. Try a simpler expression.")), 5_000) };
        worker.postMessage({ messages, pattern, type });
      });
    },
    async close() { stopped = true; await worker.terminate(); },
  };
}

export async function redactMessages(messages, pattern, type) {
  const redactor = createRedactor();
  try { return await redactor.redact(messages, pattern, type); }
  finally { await redactor.close(); }
}

if (!isMainThread) parentPort.on("message", ({ messages, pattern, type }) => {
  try {
    const expression = new RegExp(type === "regex" ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    let count = 0;
    if (expression.test("")) throw new Error("The expression cannot match empty text.");
    const redacted = messages.map(message => ({ ...message, text: message.text.replace(expression, match => {
      if (!match.length) throw new Error("The expression cannot match empty text.");
      count++;
      return "[REDACTED CUSTOM]";
    }) }));
    parentPort.postMessage({ messages: redacted, count });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
});
