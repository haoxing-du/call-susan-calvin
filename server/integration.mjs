import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

// Only local process configuration crosses this channel. Nothing is put in a URL.
export function launchReview({ demo = false, feedback = null, demoRoots = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./integration-child.mjs", import.meta.url)), [], {
      detached: true, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const fail = (error) => { clearTimeout(timer); child.kill(); reject(error); };
    const timer = setTimeout(() => fail(new Error("Susan Calvin could not finish discovering sessions. Try the standalone command.")), 120_000);
    child.once("error", fail);
    child.once("exit", () => fail(new Error("Susan Calvin stopped before it was ready.")));
    child.once("message", (message) => {
      if (message?.error) return fail(new Error(message.error));
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(message?.url || "")) return fail(new Error("Invalid local review address."));
      clearTimeout(timer);
      child.removeAllListeners("exit"); child.removeAllListeners("error");
      child.disconnect(); child.unref();
      resolve({ url: message.url });
    });
    child.send({ demo: demo === true, feedback, ...(demo ? { demoRoots } : {}) });
  });
}
