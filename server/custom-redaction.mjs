import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

// Run donor-supplied expressions away from the local server, with a time limit.
export function redactMessages(messages, pattern, type) {
  if (typeof pattern !== "string" || !pattern.length || pattern.length > 200 || !["text", "regex"].includes(type)) throw new Error("Enter text or a regular expression of up to 200 characters.");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { messages, pattern, type } });
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error("This pattern took too long. Try a simpler expression.")); }, 5_000);
    worker.once("message", (result) => { clearTimeout(timer); resolve(result); });
    worker.once("error", (error) => { clearTimeout(timer); reject(error); });
    worker.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error("Redaction stopped. Try a simpler expression.")); });
  });
}

if (!isMainThread) {
  const { messages, pattern, type } = workerData;
  const expression = new RegExp(type === "regex" ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  let count = 0;
  if (expression.test("")) throw new Error("The expression cannot match empty text.");
  const redacted = messages.map((message) => ({ ...message, text: message.text.replace(expression, (match) => {
    if (!match.length) throw new Error("The expression cannot match empty text.");
    count++;
    return "[REDACTED CUSTOM]";
  }) }));
  parentPort.postMessage({ messages: redacted, count });
}
