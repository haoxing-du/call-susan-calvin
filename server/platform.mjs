import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export function canonicalSessionRoots({ home = os.homedir(), platform = process.platform } = {}) {
  return {
    claudeRoot: path.join(home, ".claude", "projects"),
    codexRoots: [path.join(home, ".codex", "sessions"), path.join(home, ".codex", "archived_sessions")],
    coworkRoot: platform === "darwin" ? path.join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions") : null,
  };
}

export function openExternalUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const command = platform === "darwin" ? ["open", [url]] : platform === "linux" ? ["xdg-open", [url]] : null;
  if (!command) return false;
  const child = spawnImpl(command[0], command[1], { detached: true, stdio: "ignore" });
  child.on?.("error", () => {});
  child.unref?.();
  return true;
}

