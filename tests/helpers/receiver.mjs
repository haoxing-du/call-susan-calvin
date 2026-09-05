import fs from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

export async function createReceiver() {
  const compiled = await build({ entryPoints: [new URL("../../worker/donation-worker.mjs", import.meta.url).pathname], bundle: true, write: false, format: "esm", platform: "neutral" });
  const mf = new Miniflare({ cf: false, workers: [
    { name: "receiver", modules: true, script: compiled.outputFiles[0].text, compatibilityDate: "2026-04-26", d1Databases: { DONATION_METADATA: "test-metadata" }, r2Buckets: { DONATIONS: "test-donations" }, serviceBindings: { ZULIP_NOTIFIER: { name: "notifier", entrypoint: "DonationNotifications" } } },
    { name: "notifier", modules: true, compatibilityDate: "2026-04-26", d1Databases: { DB: "test-metadata" }, script: `import { WorkerEntrypoint } from "cloudflare:workers";
      export class DonationNotifications extends WorkerEntrypoint {
        async notifyDonation(payload) {
          await this.env.DB.prepare("INSERT INTO test_deliveries (payload) VALUES (?)").bind(JSON.stringify(payload)).run();
          return { sent: true };
        }
      }
      export default { fetch() { return new Response("Not found", { status: 404 }); } };` },
  ] });
  const db = await mf.getD1Database("DONATION_METADATA", "receiver");
  for (const name of ["0001_susan_calvin_donations.sql", "0002_donation_batches.sql"]) {
    const sql = await fs.readFile(new URL(`../../migrations/${name}`, import.meta.url), "utf8");
    for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare("CREATE TABLE test_deliveries (payload TEXT)").run();
  return { mf, db, bucket: await mf.getR2Bucket("DONATIONS", "receiver") };
}
