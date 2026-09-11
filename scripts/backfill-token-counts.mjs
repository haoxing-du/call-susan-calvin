#!/usr/bin/env node
// Maintainer-only: decrypt in memory; persist only counts, never transcript text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { decryptDonation, parseStoredDonation } from "../server/donation-crypto.mjs";
import { countTranscriptTokens, TOKEN_ENCODING } from "../server/transcript-tokens.mjs";

const apply = process.argv.includes("--apply");
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
function wrangler(args) {
  // Wrangler output can contain private object IDs. Keep it out of logs.
  try { return execFileSync("npx", ["--yes", "wrangler@4.86.0", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10_000_000 }); }
  catch { throw new Error("Cloudflare operation failed. Check authentication and retry the backfill."); }
}
function query(database, sql) {
  const result = JSON.parse(wrangler(["d1", "execute", database, "--remote", "--command", sql, "--json"]));
  if (!Array.isArray(result) || result.some(item => !item.success)) throw new Error("Database query failed.");
  return result.flatMap(item => item.results);
}
function loadKey() {
  for (const app of ["susan-calvin", "behavior-wrapped"]) {
    const file = path.join(os.homedir(), ".config", app, "keys", "research-donation-rsa-2026-08.pem");
    if (!fs.existsSync(file)) continue;
    let passphrase = process.env.SUSAN_CALVIN_DONATION_KEY_PASSPHRASE || process.env.BEHAVIOR_WRAPPED_DONATION_KEY_PASSPHRASE;
    if (!passphrase && process.platform === "darwin") {
      try { passphrase = execFileSync("security", ["find-generic-password", "-a", os.userInfo().username, "-s", `${app}-research-key-2026-08`, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { continue; }
    }
    if (passphrase) return { key: fs.readFileSync(file, "utf8"), passphrase };
  }
  throw new Error("The maintainer research key and passphrase are unavailable.");
}
const sources = [
  { name: "Susan", database: "susan-calvin-donation-metadata", bucket: "susan-calvin-donations", sql: "SELECT id, object_key FROM susan_calvin_donations WHERE token_count IS NULL", decrypt: decryptDonation },
  { name: "Legacy", database: "behavior-wrapped-research-metadata", bucket: "behavior-wrapped-research-donations", sql: "SELECT d.id, d.object_key FROM research_donations d LEFT JOIN research_donation_token_counts t ON t.donation_id = d.id WHERE t.donation_id IS NULL" },
];
const { key, passphrase } = loadKey();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "susan-token-backfill-"));
fs.chmodSync(directory, 0o700);
try {
  for (const source of sources) {
    const rows = query(source.database, source.sql);
    if (!rows.length) { console.log(`${source.name}: no missing token counts.`); continue; }
    if (!source.decrypt) {
      const index = process.argv.indexOf("--legacy-module");
      const file = index >= 0 ? process.argv[index + 1] : new URL("../../agent-behavior-wrapped/server/research-donation-crypto.mjs", import.meta.url).pathname;
      source.decrypt = (await import(pathToFileURL(path.resolve(file)).href)).decryptResearchDonation;
    }
    let total = 0;
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index], file = path.join(directory, "encrypted-object");
      wrangler(["r2", "object", "get", `${source.bucket}/${row.object_key}`, "--remote", "--file", file]);
      const donation = source.decrypt(parseStoredDonation(fs.readFileSync(file)), key, passphrase);
      const tokens = countTranscriptTokens(donation);
      if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("Invalid token count.");
      if (apply) {
        const sql = source.name === "Susan"
          ? `UPDATE susan_calvin_donations SET token_count = ${tokens}, token_encoding = ${quote(TOKEN_ENCODING)} WHERE id = ${quote(row.id)} AND object_key = ${quote(row.object_key)} AND token_count IS NULL`
          : `INSERT OR IGNORE INTO research_donation_token_counts (donation_id, token_count, token_encoding) SELECT id, ${tokens}, ${quote(TOKEN_ENCODING)} FROM research_donations WHERE id = ${quote(row.id)} AND object_key = ${quote(row.object_key)}`;
        query(source.database, sql);
      }
      total += tokens;
      fs.unlinkSync(file);
      console.log(`${source.name}: ${index + 1}/${rows.length} packets counted.`);
    }
    console.log(`${source.name}: ${total.toLocaleString("en-US")} tokens ${apply ? "saved" : "counted (dry run)"}.`);
  }
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
