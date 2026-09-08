import { startLocalApp } from "./launcher.mjs";

process.once("message", async ({ demo, feedback, demoRoots }) => {
  try {
    const local = await startLocalApp({ port: 0, demo, feedback, demoRoots, integration: true });
    const stop = () => { local.server.close(); local.server.closeIdleConnections(); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    process.send({ url: local.url });
  } catch (error) {
    process.send({ error: error.message }, () => process.exit(1));
  }
});
