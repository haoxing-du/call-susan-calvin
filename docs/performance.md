# Large-donation verification

On September 5, 2026, the synthetic end-to-end test processed **14,100 sessions and 573,700 messages**. This is 100 times the measured session/message counts of the maintainer's complete local history (141 sessions, 5,737 extracted messages). No private conversation text was copied into the test.

The synthetic transcripts contained **379,766,890 bytes of text** (468,087,590 bytes of input JSONL), exceeding 100 times the original extracted JSON volume of 3,421,155 bytes. The test used independently generated, spaced random text so compression was not artificially easy.

The run exercised discovery, automatic redaction, private disk snapshots, batch planning, encryption, client submission, the actual Worker under Miniflare with local D1/R2, private-service notification delivery, decryption of every object, and deletion. It completed in **83 seconds** on the maintainer's machine:

- 106 encrypted batches; largest HTTP request 3,488,455 bytes.
- All 14,100 sessions and 573,700 messages recovered; the complete ordered transcript checksum matched.
- A simulated lost acknowledgement after storage retried without creating a duplicate.
- A simulated HTTP 429 retried successfully.
- Exactly one aggregate notification was delivered.
- Group deletion removed every encrypted object and donation record.
- Peak Node RSS for the combined generator/test harness was 530,251,776 bytes; this excludes the browser and separate Worker process and is not a production memory measurement.

This measures total history size, not one unusually large session. Each session remains bounded to 7 MB of JSON and 50,000 messages. The UI keeps only one transcript loaded and at most 40 messages rendered, while complete review snapshots stay on local disk. The receiver processes one bounded request at a time.

Run `npm run test:stress` to repeat the full local test. Smaller development runs can set `STRESS_SESSIONS` and `STRESS_MESSAGES`. Normal `npm run check` includes smaller integration tests against the real Worker runtime, database, object storage, and notification service binding.
