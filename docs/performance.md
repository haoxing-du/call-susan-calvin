# Large-donation verification

On September 5, 2026, the synthetic end-to-end test processed **14,100 sessions and 573,700 messages**. This is 100 times the measured session/message counts of the maintainer's complete local history (141 sessions, 5,737 extracted messages). No private conversation text was copied into the test.

The synthetic transcripts contained **379,766,890 bytes of text** (468,087,590 bytes of input JSONL), exceeding 100 times the original extracted JSON volume of 3,421,155 bytes. The test used independently generated, spaced random text so compression was not artificially easy.

The final run exercised discovery, automatic redaction, private disk snapshots, batch planning, encryption, submission to both the local Worker runtime and **the deployed production receiver**, decryption of every locally stored test object, and deletion. The complete test took **239 seconds**, including fixture generation, local verification, production uploads, and the notification check:

- 106 encrypted batches; largest binary request 2,615,824 bytes.
- Production stored **274,405,993 encrypted bytes**, with exactly 14,100 sessions and 573,700 messages in D1.
- Every locally stored batch decrypted successfully; the complete ordered transcript checksum matched. R2 verified each production object's SHA-256 checksum during upload.
- Simulated lost acknowledgements and rate limits retried without duplicates.
- Exactly one aggregate notification was delivered locally; the production outbox also recorded acknowledgement from the real Zulip bot.
- Both local and production synthetic donations were deleted. Local test receipts and temporary fixtures were removed.
- Peak Node RSS for the combined generator/test harness was 460,767,232 bytes; this excludes the browser and separate Worker process and is not a production app memory measurement.

Production testing uncovered a constraint that local emulation did not enforce: large JSON envelopes could exceed Cloudflare's 10 ms CPU limit. The final protocol streams binary ciphertext directly into R2, with storage performing checksum verification. Observed upload CPU was typically 2–3 ms. Deletion is also paged into five objects per call to keep its CPU use small. The client retries all temporary server errors with up to eight attempts and cancellable backoff.

This measures total history size, not one unusually large session. Each session remains bounded to 7 MB of JSON and 50,000 messages. The UI keeps only one transcript loaded and at most 40 messages rendered, while complete review snapshots stay on local disk. The receiver processes one bounded request at a time.

Run `npm run test:stress` to repeat the full local test. Smaller development runs can set `STRESS_SESSIONS` and `STRESS_MESSAGES`. Normal `npm run check` includes smaller integration tests against the real Worker runtime, database, object storage, and notification service binding.

Production verification is an explicit opt-in: `STRESS_PRODUCTION=1 npm run test:stress`. It sends synthetic data, creates a real Zulip alert, checks production totals and delivery, and deletes its own donation using a receipt saved before transmission. Never use personal transcripts as load-test fixtures.
