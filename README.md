# Share with Susan Calvin

Share with Susan Calvin is a local-first tool for reviewing and securely donating real-world AI agent conversations to the [Susan Calvin Project](https://susancalvin.org). It does not perform behavioral analysis, publish reports, or contact an LLM.

## Quick start

Requires Node.js 20 or newer on macOS or Linux.

```bash
npx share-with-susan-calvin@latest
```

The command discovers recent Claude Code, Claude Cowork, and Codex sessions and opens a review app on localhost. Nothing is transmitted while sessions are discovered, selected, redacted or reviewed. A donation is sent only after explicit consent and a click on **Donate**.

To explore the complete interface using synthetic conversations without transmitting anything:

```bash
npx share-with-susan-calvin@latest --demo
```

Session selection shows saved titles when available and a two-line excerpt of the first user message. Titles come from Claude Code transcript records, Claude Cowork session metadata, and the Codex session index. Missing titles fall back to the agent name and date. No LLM request is made. These display details stay local and are excluded from donation metadata. ChatGPT web and Claude web histories are not currently imported.

## Review modes

- **Standard** applies high-confidence credential and common personal-identifier redactions locally, then shows every included message.
- **Customize** starts with every standard redaction applied. Donors can disable individual automatic redactions or add plain-text and regular-expression redactions. Matches are replaced with a fixed `[REDACTED]` marker; messages cannot be freely rewritten or removed. To omit a transcript, deselect the entire session.
- **Unredacted** disables automatic safeguards, displays a prominent warning, and requires an additional acknowledgement.

Messages are read-only in every mode. Original message timestamps are included whenever available. Project names, filesystem paths used for discovery, and local session identifiers are never included as donation metadata.

## Options and management

Discovery covers the past 30 days by default. Set `--days=N` to change the window;
for example, `npx share-with-susan-calvin@latest --days=90` covers the past 90 days.

```text
share-with-susan-calvin [--days=30] [--source=claude,cowork,codex] [--no-open]
share-with-susan-calvin --demo
share-with-susan-calvin list
share-with-susan-calvin delete <donation-id>
```

Deletion receipts are stored with restrictive permissions under `~/.call-susan-calvin/donation-receipts`. This directory is retained from the previous package name so existing donations can still be managed. Deleting a donation removes both its encrypted object and its research metadata before removing the local receipt.

Codex can store injected setup and plugin information with the user role. In the review, recognized leading context blocks appear in a collapsed **Codex context · included in donation** section, separate from the actual user prompt. Expand the section to inspect or redact it. The original role, message order, and context remain in the reviewed donation.

## Local server lifetime

The command runs a foreground server on `127.0.0.1:4318` by default. Stop it with Ctrl+C, or use **Close window and stop local server** on the donation success screen. If the browser prevents the page from closing its own tab, the server still stops and the page says it is safe to close. Closing a tab by itself does not stop the server. There is no idle timeout or automatic restart.

The app opens on a donation-wide redaction overview. It lists every automatic rule, its status, and the number of instances replaced across all included sessions, with standard and custom rules listed in the same table. Every custom rule shows its full text or pattern, type, status, and instance count. Remove deletes that one rule across the donation; the remaining rules are reapplied to the original review snapshot. Active rules with zero matches remain visible. Counts update when inclusion, mode, rules, or custom redactions change; browsing and searching do not change them. Click a session title to view its transcript without changing its donation checkbox. The overall total stays visible, and Back to overview reopens the full table. Unchecked sessions can be inspected but do not contribute to donation totals.

The session catalog is built at startup. Restart to discover new sessions. Selection and consent reset on page reload. Preparing a preview creates an owner-only temporary snapshot on this device; custom redactions are saved immediately to that snapshot. Custom redaction patterns stay in local-server memory, until that server stops. Changing selections or automatic rules rebuilds the snapshot and reapplies those patterns in Custom mode. Standard and Unredacted modes keep the patterns saved without applying them; returning to Custom mode applies them again. **Reset all custom redactions** removes all saved custom patterns and preserves the current automatic rules. Review the resulting text after changing rules. Source histories are never modified. Snapshots are removed after successful upload, when replaced, or when the server closes normally. A forced process kill or machine crash may leave temporary files until cleanup.

A session index (including brief excerpts and transcript titles) and deletion receipts persist under `~/.call-susan-calvin/` with owner-only permissions. Demo mode does not write this index or donation receipts.

## Large donations

The picker displays at most 30 sessions per page, with pagination hidden for shorter lists. Search finds titles, first-message excerpts, and agent names across the whole catalog without changing donation selection. Review displays one session and up to 40 messages at a time. A session opens only when its title is clicked; its preview can load while the full donation prepares in the background; changing options cancels obsolete preparation. Consent remains disabled until the current snapshot is ready. All selected sessions remain included. Text, regular-expression, and automatic redaction preferences apply across all included sessions, including sessions added later. Category controls and matched values live in the donation overview. In Customize mode, the custom text/pattern form is visible immediately; no individual session needs to be open. Expand a category to see every distinct matched string and its total occurrence count across included sessions. Click a matched value to open its message and local context, then use Previous/Next occurrence to inspect every occurrence across included sessions. Message pagination and the transcript scroll position update automatically. In Customize mode, the context view also lets you leave that value unredacted across all included sessions. Turning a category back on restores all values in that category.

Up to 100,000 sessions can be reviewed. Uploads are packed into batches of roughly 4 MB before compression, with complete sessions kept together. A single session may contain up to 7 MB of JSON and 50,000 messages; oversized sessions are reported before upload rather than truncated. The total donation can exceed the old 250-session and 20 MB limits.

The app uploads ciphertext as a binary stream, displays progress, and retries temporary network errors and rate limits with up to eight attempts and increasing delays. If retries are exhausted, **Retry remaining upload** continues the same frozen snapshot while the server remains open. Reloading or restarting does not resume an upload; the saved group receipt still allows every accepted batch to be deleted with `share-with-susan-calvin delete <donation-id>`. Receipts are written **before** transmission, so they also cover partial uploads and lost acknowledgements.

## Security model

The reviewed `susan-calvin-donation-v1` payload is validated, compressed, and encrypted locally using a fresh AES-256-GCM content key. That key is wrapped with the project's rotation-versioned RSA-OAEP-256 public key. The receiver stores ciphertext separately from minimal consent and lifecycle metadata. Its private decryption key is not included in this package or deployed receiver.

Automatic redaction is intentionally conservative and cannot guarantee detection of every private detail. The exact final transcript preview and separate consent step remain the primary safeguards. See [Privacy and security](docs/privacy.md), [Donation protocol](docs/protocol.md), and the [Susan Calvin Project data policy](https://susancalvin.org/data-policy).

## Development

```bash
npm test
npm run check
npm run demo -- --no-open
npm run test:stress
```

The receiver Worker is in `worker/donation-worker.mjs`. Apply pending D1 migrations before deployment:

```bash
npm run db:migrate:remote
npm run worker:deploy
```

Donation alerts reuse the Behavior Wrapped Zulip bot through a private Cloudflare service binding. One aggregate notification is queued after all batches arrive, and failed deliveries retry every five minutes. The notification contains counts and redaction mode, never transcript text. The sibling Worker must expose the `DonationNotifications` entrypoint before deploying this receiver.

## License

Apache-2.0. See [LICENSE](LICENSE).
