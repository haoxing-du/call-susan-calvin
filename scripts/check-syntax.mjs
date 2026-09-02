import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["server", "worker", "scripts", "app"];
const files = roots.flatMap((root) => fs.existsSync(root)
  ? fs.readdirSync(root, { recursive: true }).filter((file) => file.endsWith(".mjs") || file.endsWith(".js")).map((file) => path.join(root, file))
  : []);

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Checked ${files.length} JavaScript files.`);

