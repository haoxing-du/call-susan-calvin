#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { decryptDonation, parseStoredDonation } from "../server/donation-crypto.mjs";

const [, , inputArgument, outputArgument, keyArgument] = process.argv;
if (!inputArgument || !outputArgument) {
  console.error("Usage: npm run research:decrypt -- <encrypted-envelope.json|.bin> <private-output.json> [private-key.pem]");
  process.exit(1);
}

const input = path.resolve(inputArgument);
const output = path.resolve(outputArgument);
const privateKeyPath = path.resolve(keyArgument || path.join(os.homedir(), ".config", "susan-calvin", "keys", "research-donation-rsa-2026-08.pem"));
let keychainPassphrase = "";
if (process.platform === "darwin" && !process.env.SUSAN_CALVIN_DONATION_KEY_PASSPHRASE) {
  try { keychainPassphrase = execFileSync("security", ["find-generic-password", "-a", os.userInfo().username, "-s", "susan-calvin-research-key-2026-08", "-w"], { encoding: "utf8" }).trim(); }
  catch { /* The environment variable fallback is explained below. */ }
}
const passphrase = process.env.SUSAN_CALVIN_DONATION_KEY_PASSPHRASE || keychainPassphrase;
if (!passphrase) throw new Error("Set SUSAN_CALVIN_DONATION_KEY_PASSPHRASE or configure the maintainer Keychain entry before decrypting.");
const envelope = parseStoredDonation(fs.readFileSync(input));
const donation = decryptDonation(envelope, fs.readFileSync(privateKeyPath, "utf8"), passphrase);
fs.writeFileSync(output, `${JSON.stringify(donation, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(`Decrypted donation written with private permissions: ${output}`);

