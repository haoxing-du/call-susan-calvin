# Maintainer operations

The private research key must remain outside this repository, the npm package, the Worker, D1, and R2. The bundled public key currently identifies `research-donation-rsa-2026-08`.

The default private-key location is `~/.config/susan-calvin/keys/research-donation-rsa-2026-08.pem`. On macOS, the decrypt command looks for its passphrase in Keychain under service `susan-calvin-research-key-2026-08` and the current macOS username. Other environments can supply `SUSAN_CALVIN_DONATION_KEY_PASSPHRASE` for the duration of the command.

After downloading one encrypted R2 object into a private working directory, decrypt it into a new file:

```bash
npm run research:decrypt -- encrypted-envelope.json private-donation.json
```

An alternate private-key path may be supplied as the third argument. The output is created with mode `0600`, and the command refuses to overwrite an existing file. Never commit decrypted donations or upload them back to object storage.

Before accepting production donations, back up the encrypted private key and its passphrase through separate secure channels. Test decryption with a synthetic envelope after every key rotation, schema change, or collector release.


Legacy Behavior Wrapped ciphertext remains in `behavior-wrapped-research-donations` and its metadata in `behavior-wrapped-research-metadata`, bound as `LEGACY_RESEARCH_DONATIONS` and `LEGACY_RESEARCH_DB`. Do not apply Susan migrations to that database. Use Behavior Wrapped's historical decrypt command for legacy envelopes; its schema and authenticated metadata differ even though the public key is shared. No stored data migration is required.

Deploy this receiver with legacy bindings and feedback consent-version support before releasing the integrated collector or removing Wrapped's original receiver. Wrapped retains only a service forwarder for old deletion URLs. Keep its `DonationNotifications` service available for aggregate notifications.

## Public contribution statistics

Before deploying the stats receiver, apply the normal Susan migrations, then run
`npx --yes wrangler@4.86.0 d1 execute behavior-wrapped-research-metadata --remote --file migrations-legacy/0001_token_counts.sql`.
The legacy script only adds a token-count table; it does not change historical donations.

Run `node scripts/backfill-token-counts.mjs --apply` to count existing donations.
Without `--apply`, it calculates counts without changing the databases. The script
uses the maintainer key and Wrangler authentication, downloads ciphertext into a
private temporary directory, decrypts only in memory, and saves only token counts.
Legacy decryption uses the adjacent `agent-behavior-wrapped` checkout by default;
pass `--legacy-module /absolute/path/to/server/research-donation-crypto.mjs` to use
another checkout. Rerun after any older client submits a donation without tokens.
It is resumable and will not recreate deleted donation records.

`GET /v1/stats` publishes only contributors, sessions, tokens, and updatedAt.
Only complete active groups and legacy donations count. Missing token counts
produce `tokens: null`, never a misleading partial total. Legacy and pre-ID Susan
donations each count as a separate contributor. New IDs deduplicate installations,
not people across devices. Sessions are not deduplicated across separate donations.
The receiver cannot verify client token counts without the private decryption key;
these are corpus-size statistics, not an audited usage or billing measure.
