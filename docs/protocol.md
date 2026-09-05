# Donation protocol

The collector and receiver use independent version identifiers so either layer can evolve without ambiguity.

## Plaintext payload

The locally reviewed and normalized plaintext uses the format `susan-calvin-donation-v1`:

```json
{
  "format": "susan-calvin-donation-v1",
  "donationRunId": "opaque UUID",
  "collector": { "name": "share-with-susan-calvin", "version": "0.1.1" },
  "sourceTypes": ["codex"],
  "redactionMode": "standard",
  "createdAt": "ISO-8601 timestamp",
  "redactionSummary": {
    "automatedDetections": 4,
    "sessions": 1,
    "messages": 12
  },
  "sessions": [
    {
      "source": "codex",
      "messages": [
        { "role": "user", "text": "Reviewed text" }
      ]
    }
  ],
  "consent": {
    "researchDonation": true,
    "consentVersion": 1,
    "statement": "Canonical consent statement",
    "consentedAt": "ISO-8601 timestamp"
  }
}
```

The schema accepts at most 250 sessions, 50,000 messages, 7,000,000 characters per message, and 20 MB of normalized JSON. Unknown agent sources, roles, redaction modes, or invalid timestamps are rejected. Empty or whitespace-only message text is rejected rather than silently removing a turn. Local labels and session identifiers are discarded.

## Encrypted envelope

The encryption structure is `susan-calvin-encrypted-donation-v1`. Protocol 1 transmits it as JSON; current collectors use streamed protocol 2, described below. Plaintext is gzipped and encrypted with AES-256-GCM. Its random content key is wrapped with the public key identified by `research-donation-rsa-2026-08` using RSA-OAEP with SHA-256.

Envelope metadata contains the donation run ID, collector version, source types, redaction mode, timestamps, consent version, counts, compression mode, and an unredacted-data flag. The format, encryption algorithm, key ID, and complete metadata object are supplied as AES-GCM additional authenticated data.

The legacy client sends the JSON envelope to `POST /v1/donations` with protocol and locally generated deletion-token headers. The donation run ID and deletion token make retries idempotent: repeating an interrupted submission cannot create a second object. The receiver stores only a hash of the deletion token.

Deletion uses `DELETE /v1/donations/:id` with the same protocol and deletion-token headers. The receiver deletes the encrypted object before removing its metadata record.


## Multi-batch donations

The limits above apply to **one batch**. The local review supports 100,000 sessions and plans batches around 4 MB, never splitting a session. A session over 7 MB of JSON or 50,000 messages is rejected at preview time. Compressed ciphertext remains bounded to 8 MB.

Batched plaintext adds `group: { id, index, count }`. The envelope authenticates the matching `groupId`, `batchIndex` (zero-based), and `batchCount`. Each batch has its own deterministic run ID derived from the random review/group ID and index; the group shares one random deletion token. Group count and redaction mode are fixed by the first accepted batch. `(group_id, batch_index)` is unique. Legacy single-envelope uploads remain supported.

To reconstruct a group, require the declared number of batches, validate identical group IDs/counts and unique indices `0..count-1`, decrypt each envelope, and concatenate its session arrays in batch-index order. No session crosses a batch boundary. Labels, paths and original session identifiers remain excluded.

The local client saves the group deletion credential before its first upload, encrypts one batch at a time, and retries the identical encrypted body for transient failures. A donor retries an exhausted upload from its first unacknowledged batch while the original server is running. Already accepted run IDs return their existing receipt.

`DELETE /v1/donation-groups/:id` authenticates the shared token, marks the group closed to uploads, and removes up to 5 objects per call. Repeat while `remaining` is true. Requests are idempotent. Minimal group tombstones prevent delayed retries from resurrecting deleted donations.

A D1 outbox queues one aggregate alert for a completed group (or one legacy donation). Atomic claims avoid concurrent deliveries. `waitUntil` attempts immediate delivery through the internal Zulip service; the scheduled handler retries pending alerts every five minutes. Zulip delivery is at least once, since its acknowledgement and the D1 update cannot be committed atomically.

## Streamed transport (protocol 2)

The default collector uses `x-susan-calvin-protocol: 2`. Encryption and authenticated metadata remain identical to protocol 1. The JSON envelope header (format, encryption parameters, metadata) travels in `x-susan-calvin-envelope`; the request body contains raw binary ciphertext. `x-susan-calvin-ciphertext-bytes` declares its bounded length, and `x-susan-calvin-object-sha256` is the SHA-256 digest of the complete storage representation described below.

The receiver validates only the small header. It prepends the storage prefix and pipes the ciphertext through a `FixedLengthStream` directly into R2, which verifies the SHA-256 checksum. This avoids parsing, stringifying, and hashing megabytes inside the Worker's CPU budget. Incorrect lengths or checksums do not create a donation record.

The `.bin` storage representation is the ASCII line `susan-calvin-encrypted-stream-v2`, a newline, the JSON header, another newline, then binary ciphertext. `parseStoredDonation` and `npm run research:decrypt` support this representation and legacy `.json` objects. D1's `object_sha256` holds the R2-verified whole-object checksum; the legacy `ciphertext_sha256` field is empty for streamed objects.
