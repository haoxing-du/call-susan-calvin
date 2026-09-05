# Privacy and security

Share with Susan Calvin separates local discovery and review from optional encrypted transmission.

## Before consent

The CLI reads supported session histories from the user's Claude Code, Cowork, and Codex data directories. It streams JSONL records, caches only session-level indexing metadata, and serves the review interface on `127.0.0.1`. The local server rejects state-changing browser requests from other origins.

Discovery, date and source filtering, session selection, automatic redaction, custom replacements, message editing, exclusions, and final preview all happen locally. The program makes no service request during these steps. Installing the package through npm is a separate network operation performed by npm.

## Reviewed donation

Standard mode redacts recognized credentials, common token formats, private keys, email addresses, North American phone numbers, Social Security numbers, possible payment-card numbers, and usernames in macOS or Linux home-directory paths. Code, URLs, non-home paths, and private prose remain because they may be important research context. Automated detection is incomplete, so every mode provides an exact editable preview.

Custom mode permits automatic rules to be disabled and lets donors add plain-text or regular-expression replacements. Unredacted mode disables automatic redaction and requires an additional warning acknowledgement. Message timestamps are excluded by default.

The final schema removes local session IDs and display labels. It retains each session's agent source so researchers can interpret the transcript, along with bounded counts, collector version, redaction mode, and versioned consent.

## Encryption and storage

After consent, the reviewed payload is validated against a strict size-bounded schema and compressed with gzip. A new random 256-bit content key and 96-bit IV are generated for each donation. Transcript content is protected with authenticated AES-256-GCM encryption, and the content key is wrapped using RSA-OAEP with SHA-256. Authenticated metadata prevents counts or consent fields from being changed without detection.

The receiving Worker accepts only the versioned encrypted envelope. Ciphertext is stored in a private R2 bucket. A D1 database holds the opaque donation reference, hashed deletion token, object location, encryption version, source types, size and count fields, and consent lifecycle metadata. It does not hold transcript text.

## Local state and deletion

Successful donations create a local deletion receipt under `~/.call-susan-calvin/donation-receipts`. Directories use owner-only permissions and receipt files use mode `0600`. The deletion token itself is stored only in this local receipt and as a one-way hash in remote metadata.

`share-with-susan-calvin delete <donation-id>` authenticates with that receipt, deletes the ciphertext object, deletes its metadata record, and then removes the local receipt. Losing the receipt may make self-service deletion impossible, so users should preserve the local application directory while a donation remains active.

The public data-use and storage policy is maintained at [susancalvin.org/data-policy](https://susancalvin.org/data-policy).

