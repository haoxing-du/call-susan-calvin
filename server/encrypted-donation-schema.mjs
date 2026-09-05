import { DONATION_CONSENT_VERSION } from "./donation-schema.mjs";

export const ENVELOPE_FORMAT = "susan-calvin-encrypted-donation-v1";
export const ENCRYPTION_ALGORITHM = "RSA-OAEP-256+A256GCM";
export const ENCRYPTION_KEY_ID = "research-donation-rsa-2026-08";
export const CONTENT_ENCODING = "gzip";
export const MAX_COMPRESSED_BYTES = 8_000_000;
export const MAX_ENCRYPTED_BYTES = Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4 + 12_000;
const base64url = /^[A-Za-z0-9_-]+$/;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function boundedInteger(value, maximum, minimum = 0) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function envelopeAAD(envelope) {
  return JSON.stringify({ format: envelope.format, encryption: { algorithm: envelope.encryption.algorithm, keyId: envelope.encryption.keyId }, metadata: envelope.metadata });
}

export function sanitizeEncryptedEnvelope(value) {
  if (!exactKeys(value, ["ciphertext", "encryption", "format", "metadata"]) || value.format !== ENVELOPE_FORMAT) return null;
  if (!exactKeys(value.encryption, ["algorithm", "authTag", "iv", "keyId", "wrappedKey"])) return null;
  if (value.encryption.algorithm !== ENCRYPTION_ALGORITHM || value.encryption.keyId !== ENCRYPTION_KEY_ID) return null;
  if (typeof value.encryption.wrappedKey !== "string" || value.encryption.wrappedKey.length < 480 || value.encryption.wrappedKey.length > 700 || !base64url.test(value.encryption.wrappedKey)) return null;
  if (typeof value.encryption.iv !== "string" || value.encryption.iv.length !== 16 || !base64url.test(value.encryption.iv)) return null;
  if (typeof value.encryption.authTag !== "string" || value.encryption.authTag.length !== 22 || !base64url.test(value.encryption.authTag)) return null;
  if (typeof value.ciphertext !== "string" || !value.ciphertext || value.ciphertext.length > Math.ceil(MAX_COMPRESSED_BYTES / 3) * 4 || !base64url.test(value.ciphertext)) return null;
  const metadataKeys = ["automatedDetections", "collectorVersion", "consentedAt", "consentVersion", "contentEncoding", "createdAt", "donationRunId", "messages", "redactionMode", "sessions", "sourceTypes", "unredactedData"];
  if (value.metadata?.groupId !== undefined) metadataKeys.push("groupId", "batchIndex", "batchCount");
  if (!exactKeys(value.metadata, metadataKeys)) return null;
  const metadata = value.metadata;
  if (!/^[0-9a-f-]{36}$/.test(metadata.donationRunId || "") || metadata.contentEncoding !== CONTENT_ENCODING) return null;
  if (typeof metadata.collectorVersion !== "string" || !/^[A-Za-z0-9._+-]{1,32}$/.test(metadata.collectorVersion)) return null;
  if (!Array.isArray(metadata.sourceTypes) || !metadata.sourceTypes.length || metadata.sourceTypes.length > 3 || new Set(metadata.sourceTypes).size !== metadata.sourceTypes.length || metadata.sourceTypes.some((source) => !["claude", "cowork", "codex"].includes(source)) || metadata.sourceTypes.join("|") !== [...metadata.sourceTypes].sort().join("|")) return null;
  if (!["standard", "custom", "unredacted"].includes(metadata.redactionMode)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(metadata.createdAt || "") || !/^\d{4}-\d{2}-\d{2}T/.test(metadata.consentedAt || "")) return null;
  if (metadata.consentVersion !== DONATION_CONSENT_VERSION || typeof metadata.unredactedData !== "boolean" || metadata.unredactedData !== (metadata.redactionMode === "unredacted")) return null;
  if (!boundedInteger(metadata.automatedDetections, 1_000_000) || !boundedInteger(metadata.sessions, 250, 1) || !boundedInteger(metadata.messages, 50_000, 1)) return null;
  if (metadata.groupId !== undefined && (!/^[0-9a-f-]{36}$/.test(metadata.groupId) || !boundedInteger(metadata.batchCount, 100_000, 1) || !boundedInteger(metadata.batchIndex, metadata.batchCount - 1))) return null;
  return value;
}
