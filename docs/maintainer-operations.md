# Maintainer operations

The private research key must remain outside this repository, the npm package, the Worker, D1, and R2. The bundled public key currently identifies `research-donation-rsa-2026-08`.

The default private-key location is `~/.config/susan-calvin/keys/research-donation-rsa-2026-08.pem`. On macOS, the decrypt command looks for its passphrase in Keychain under service `susan-calvin-research-key-2026-08` and the current macOS username. Other environments can supply `SUSAN_CALVIN_DONATION_KEY_PASSPHRASE` for the duration of the command.

After downloading one encrypted R2 object into a private working directory, decrypt it into a new file:

```bash
npm run research:decrypt -- encrypted-envelope.json private-donation.json
```

An alternate private-key path may be supplied as the third argument. The output is created with mode `0600`, and the command refuses to overwrite an existing file. Never commit decrypted donations or upload them back to object storage.

Before accepting production donations, back up the encrypted private key and its passphrase through separate secure channels. Test decryption with a synthetic envelope after every key rotation, schema change, or collector release.

