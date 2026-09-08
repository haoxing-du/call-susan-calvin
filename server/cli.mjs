#!/usr/bin/env node
import { startLocalApp } from "./launcher.mjs";
import { deleteManagedDonation, listManagedDonations } from "./managed-donations.mjs";
import { openExternalUrl } from "./platform.mjs";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "start";
const useColor = Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";
const style = (text, code) => useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
const accent = (text) => style(text, "95");
const muted = (text) => style(text, "2");
const rail = muted("  │");

function valueArgument(name, fallback) {
  return args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function help() {
  console.log(`share-with-susan-calvin [--days=30] [--source=claude,cowork,codex] [--no-open]\nshare-with-susan-calvin --demo\nshare-with-susan-calvin list\nshare-with-susan-calvin delete <donation-id>`);
  console.log("\nDiscovers the past 30 days by default. Use --days=N to change the window, e.g. --days=90 for the past 90 days.");
}

async function run() {
  if (command === "help" || args.includes("--help") || args.includes("-h")) return help();
  if (command === "list") {
    const receipts = listManagedDonations();
    if (!receipts.length) return console.log("No locally managed donations.");
    for (const receipt of receipts) console.log(`${receipt.origin}:${receipt.donationId}  ${receipt.savedAt.slice(0, 10)}  ${receipt.sessionCount ? `${receipt.sessionCount} sessions` : "legacy donation"}  ${(receipt.sourceTypes || []).join(" + ")}`);
    return;
  }
  if (command === "delete") {
    const id = args[1];
    await deleteManagedDonation(id);
    console.log(`Deleted donation ${receipt.donationId}.`);
    return;
  }
  if (command !== "start") throw new Error(`Unknown command: ${command}`);
  const days = Number(valueArgument("--days", "30"));
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error("--days must be a whole number from 1 to 3650.");
  const sources = valueArgument("--source", "").split(",").filter(Boolean);
  if (sources.some((source) => !["claude", "cowork", "codex"].includes(source))) throw new Error("--source may contain claude, cowork, or codex.");
  const demo = args.includes("--demo");
  const port = Number(valueArgument("--port", "4318"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a valid port number.");

  console.log(`\n  ${accent("◇")}  ${style("Share with Susan Calvin", "1")}\n${rail}  Review and donate AI agent sessions for research\n${rail}  at the Susan Calvin Project.\n${rail}`);
  const sourceNames = { claude: "Claude Code", cowork: "Claude Cowork", codex: "Codex" };
  const discoveryLabel = demo ? "Finding local sessions…" : `Finding local sessions from the past ${style(String(days), "1")} day${days === 1 ? "" : "s"}…`;
  console.log(`  ${accent("◇")}  ${discoveryLabel}`);
  console.log(`${rail}  ${muted(demo ? "Demo data" : (sources.length ? sources : Object.keys(sourceNames)).map(source => sourceNames[source]).join(" · "))}`);
  if (!demo) console.log(`${rail}  ${muted("Change data range with --days=N, e.g. --days=90.")}`);
  const local = await startLocalApp({ port, days, sources, demo });
  if (!local.sessionCount) {
    local.server.close();
    throw new Error(`No supported agent sessions were found in the last ${days} days. Try a wider date range, such as share-with-susan-calvin --days=90, and check that your selected agents have saved sessions on this device.`);
  }
  console.log(`  ${style("✓", "32")}  ${style(`${local.sessionCount} session${local.sessionCount === 1 ? "" : "s"} ready`, "1")} ${muted("· no data transmitted yet")}\n${rail}`);
  console.log(`  ${accent("◇")}  Select, review, and redact anything locally here:\n${rail}  ${style(local.url, "1;95")}\n${rail}\n  ${muted("╰  Ctrl+C to stop the local server.")}\n`);
  if (!args.includes("--no-open")) openExternalUrl(local.url);
  const stop = () => { local.server.close(); local.server.closeIdleConnections(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

run().catch((error) => {
  console.error(`\nCould not complete the command. ${error.message}\n`);
  process.exitCode = 1;
});
