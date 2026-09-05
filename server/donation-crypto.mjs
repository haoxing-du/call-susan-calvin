import crypto from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { donationByteLength, DONATION_CONSENT_VERSION, MAX_DONATION_BYTES, sanitizeDonation } from "./donation-schema.mjs";
import { CONTENT_ENCODING, ENCRYPTION_ALGORITHM, ENCRYPTION_KEY_ID, ENVELOPE_FORMAT, envelopeAAD, MAX_COMPRESSED_BYTES, sanitizeEncryptedEnvelope } from "./encrypted-donation-schema.mjs";

export const DONATION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0RaXFQBixAmtwKRz2I7Y
pq0TlQPAZ72gHbyV2RJ9dRiDNwlwaKbHHVLYHG0QjxFanktNi/ms6NoV9slBQhjJ
Rb3kMzg5xEJYYy8TzyQKpY28f5/srGpSL2ziWRb9TSsgrOJPNk9LFPKLuJhty1+x
Gh9+I3UW+JPj+To4VY7GVU46jptP2MDtROK5v/p9PLP+QoKhjTBuDqgu5T78wTv5
/C34ZZD4ACIKvIQ8dtAZM6CPY0sWWVN84VO5etr1rYZg7DWczy2ZsX2StiKmuZ8b
kSqZr/mn6+PC5sthPCt0B+Tk1pxPv6LuwiNYubst4EKQDpFbP2e4h3KIaNxTnVRx
AHzd9XfF9rN86+Cjf55YlBuT9GeYXLttGBfoT6Llr4Xw370WIHabo7A57/atLOgw
YKX6TcNe6TOHuCTHM7LDmTPGNZdMi9cXXBUzohvTxm7O8qduIekFg4emxIiduVY2
3pHhzoP9p0kwO+L0BE1ELIHF9dk0p3s/NDIDfbiDxn5XAgMBAAE=
-----END PUBLIC KEY-----`;

export function encryptDonation(value, publicKey = DONATION_PUBLIC_KEY) {
  const byteLength = donationByteLength(value);
  if (byteLength !== null && byteLength > MAX_DONATION_BYTES) throw new Error("The reviewed donation is larger than 20 MB. Select fewer sessions.");
  const donation = sanitizeDonation(value);
  if (!donation) throw new Error("The reviewed donation does not match the Susan Calvin donation schema.");
  const compressed = gzipSync(Buffer.from(JSON.stringify(donation)));
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) throw new Error("The reviewed donation is still too large after compression. Select fewer sessions.");
  const contentKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const envelope = {
    format: ENVELOPE_FORMAT,
    encryption: { algorithm: ENCRYPTION_ALGORITHM, keyId: ENCRYPTION_KEY_ID },
    metadata: {
      donationRunId: donation.donationRunId,
      ...(donation.group ? { groupId: donation.group.id, batchIndex: donation.group.index, batchCount: donation.group.count } : {}),
      collectorVersion: donation.collector.version,
      sourceTypes: donation.sourceTypes,
      redactionMode: donation.redactionMode,
      createdAt: donation.createdAt,
      consentedAt: donation.consent.consentedAt,
      consentVersion: DONATION_CONSENT_VERSION,
      unredactedData: donation.redactionMode === "unredacted",
      automatedDetections: donation.redactionSummary.automatedDetections,
      sessions: donation.redactionSummary.sessions,
      messages: donation.redactionSummary.messages,
      contentEncoding: CONTENT_ENCODING,
    },
  };
  const cipher = crypto.createCipheriv("aes-256-gcm", contentKey, iv);
  cipher.setAAD(Buffer.from(envelopeAAD(envelope)));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return sanitizeEncryptedEnvelope({
    ...envelope,
    encryption: {
      ...envelope.encryption,
      wrappedKey: crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, contentKey).toString("base64url"),
      iv: iv.toString("base64url"),
      authTag: cipher.getAuthTag().toString("base64url"),
    },
    ciphertext: ciphertext.toString("base64url"),
  });
}

export function decryptDonation(value, privateKey, passphrase) {
  const envelope = sanitizeEncryptedEnvelope(value);
  if (!envelope) throw new Error("The encrypted donation envelope is invalid.");
  const contentKey = crypto.privateDecrypt({ key: privateKey, passphrase, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(envelope.encryption.wrappedKey, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", contentKey, Buffer.from(envelope.encryption.iv, "base64url"));
  decipher.setAAD(Buffer.from(envelopeAAD(envelope)));
  decipher.setAuthTag(Buffer.from(envelope.encryption.authTag, "base64url"));
  const compressed = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
  const plaintext = gunzipSync(compressed, { maxOutputLength: MAX_DONATION_BYTES + 1 });
  const donation = sanitizeDonation(JSON.parse(plaintext.toString("utf8")));
  if (!donation) throw new Error("The decrypted donation is invalid.");
  return donation;
}

