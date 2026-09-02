# Donation protocol

The collector and receiver use independent version identifiers so either layer can evolve without ambiguity.

## Plaintext payload

The locally reviewed and normalized plaintext uses the format `susan-calvin-donation-v1`:

```json
{
  "format": "susan-calvin-donation-v1",
  "donationRunId": "opaque UUID",
  "collector": { "name": "call-susan-calvin", "version": "0.1.0" },
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

The schema accepts at most 250 sessions, 50,000 messages, 100,000 characters per message, and 20 MB of normalized JSON. Unknown agent sources, roles, redaction modes, or invalid timestamps are rejected. Local labels and session identifiers are discarded.

## Encrypted envelope

The wire format is `susan-calvin-encrypted-donation-v1`. Plaintext is gzipped and encrypted with AES-256-GCM. Its random content key is wrapped with the public key identified by `research-donation-rsa-2026-08` using RSA-OAEP with SHA-256.

Envelope metadata contains the donation run ID, collector version, source types, redaction mode, timestamps, consent version, counts, compression mode, and an unredacted-data flag. The format, encryption algorithm, key ID, and complete metadata object are supplied as AES-GCM additional authenticated data.

The client sends the envelope to `POST /v1/donations` with protocol and locally generated deletion-token headers. The donation run ID and deletion token make retries idempotent: repeating an interrupted submission cannot create a second object. The receiver stores only a hash of the deletion token.

Deletion uses `DELETE /v1/donations/:id` with the same protocol and deletion-token headers. The receiver deletes the encrypted object before removing its metadata record.

