# Share with Susan Calvin

Share with Susan Calvin is a local-first tool for reviewing and securely donating real-world AI agent conversations to the [Susan Calvin Project](https://susancalvin.org). It does not perform behavioral analysis, publish reports, or contact an LLM.

## Quick start

Requires Node.js 20 or newer on macOS or Linux.

```bash
npx share-with-susan-calvin@latest
```

The command discovers recent Claude Code, Cowork, and Codex sessions and opens a review app on localhost. Nothing is transmitted while sessions are discovered, selected, redacted, edited, or reviewed. A donation is sent only after explicit consent and a click on **Donate**.

To explore the complete interface using synthetic conversations without transmitting anything:

```bash
npx share-with-susan-calvin@latest --demo
```

## Review modes

- **Standard** applies high-confidence credential and common personal-identifier redactions locally, then shows every included message.
- **Customize** lets the donor disable individual automatic replacements, add text or regular-expression replacements, edit messages, and exclude messages or sessions.
- **Unredacted** disables automatic safeguards, displays a prominent warning, and requires an additional acknowledgement.

Timestamps are excluded unless the donor opts in. Project names, filesystem paths used for discovery, and local session identifiers are never included as donation metadata.

## Options and management

```text
share-with-susan-calvin [--days=30] [--source=claude,cowork,codex] [--no-open]
share-with-susan-calvin --demo
share-with-susan-calvin list
share-with-susan-calvin delete <donation-id>
```

Deletion receipts are stored with restrictive permissions under `~/.call-susan-calvin/donation-receipts`. This directory is retained from the previous package name so existing donations can still be managed. Deleting a donation removes both its encrypted object and its research metadata before removing the local receipt.

## Security model

The reviewed `susan-calvin-donation-v1` payload is validated, compressed, and encrypted locally using a fresh AES-256-GCM content key. That key is wrapped with the project's rotation-versioned RSA-OAEP-256 public key. The receiver stores ciphertext separately from minimal consent and lifecycle metadata. Its private decryption key is not included in this package or deployed receiver.

Automatic redaction is intentionally conservative and cannot guarantee detection of every private detail. The exact final transcript preview and separate consent step remain the primary safeguards. See [Privacy and security](docs/privacy.md), [Donation protocol](docs/protocol.md), and the [Susan Calvin Project data policy](https://susancalvin.org/data-policy).

## Development

```bash
npm test
npm run check
npm run demo -- --no-open
```

The receiver Worker is in `worker/donation-worker.mjs`. Apply its D1 migration before the first deployment:

```bash
npm run db:migrate:remote
npm run worker:deploy
```

## License

Apache-2.0. See [LICENSE](LICENSE).
