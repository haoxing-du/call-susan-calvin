#!/usr/bin/env node
import { startLocalApp } from "./launcher.mjs";
import { deleteDonation } from "./donation-client.mjs";
import { deleteDonationReceipt, listDonationReceipts, loadDonationReceipt } from "./store.mjs";
import { openExternalUrl } from "./platform.mjs";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "start";

function valueArgument(name, fallback) {
  return args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
}

function help() {
  console.log(`call-susan-calvin [--days=30] [--source=claude,cowork,codex] [--no-open]\ncall-susan-calvin --demo\ncall-susan-calvin list\ncall-susan-calvin delete <donation-id>`);
}

async function run() {
  if (command === "help" || args.includes("--help") || args.includes("-h")) return help();
  if (command === "list") {
    const receipts = listDonationReceipts();
    if (!receipts.length) return console.log("No locally managed donations.");
    for (const receipt of receipts) console.log(`${receipt.donationId}  ${receipt.savedAt.slice(0, 10)}  ${receipt.sessionCount} sessions  ${receipt.sourceTypes.join(" + ")}`);
    return;
  }
  if (command === "delete") {
    const id = args[1];
    const receipt = loadDonationReceipt(id);
    if (!receipt) throw new Error("That local donation receipt was not found.");
    await deleteDonation(receipt.donationId, receipt.deletionToken);
    deleteDonationReceipt(receipt.donationId);
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

  console.log(`\nAgent Session Donation\nReview and donate AI agent sessions for research.\n`);
  console.log("Finding local Claude Code, Cowork, and Codex sessions…");
  const local = await startLocalApp({ port, days, sources, demo });
  if (!local.sessionCount) {
    local.server.close();
    throw new Error(`No supported agent sessions were found in the last ${days} days.`);
  }
  console.log(`Found ${local.sessionCount} eligible sessions. Nothing has left this machine.`);
  console.log(`\nReview them at ${local.url}\n`);
  if (!args.includes("--no-open")) openExternalUrl(local.url);
  const stop = () => local.server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

run().catch((error) => {
  console.error(`\nCould not start session donation. ${error.message}\n`);
  process.exitCode = 1;
});
