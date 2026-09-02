# Project instructions

## Delivery workflow

- Work directly on `main` unless the user explicitly asks for a branch or pull request.
- After completing each feature or fix, run the relevant tests and `npm run check`. Do not commit, deploy, or publish a change that fails its checks.
- Commit all completed in-scope changes with a concise descriptive message. Leave unrelated user changes untouched.
- Push each completed feature or fix directly to `origin main` after committing it.
- Deploy the website and Worker after each completed feature with `npm run worker:deploy`, then verify that the deployment succeeded. Documentation-only and repository-instruction changes do not require a website deployment.

## npm releases

- Publish a new npm release after every major change and after roughly two or three minor changes have accumulated since the previous release. Do not publish every isolated minor edit.
- Use semantic versioning: patch for compatible fixes and small accumulated improvements, minor for substantial backward-compatible features, and major for breaking changes.
- Before publishing, confirm that the intended version is not already published, update the package version and lockfile together, run `npm run check`, and review the package with `npm pack --dry-run`.
- Use npm's interactive web authentication flow. If npm is not authenticated, run `npm login --auth-type=web` in an interactive TTY, press Enter to open the authorization page in the user's default browser, and wait for the CLI to confirm login.
- Run `npm publish` in an interactive TTY. If npm requests browser authorization for the publication, press Enter to open it in the user's default browser and wait for the publish command to finish; do not replace the interactive flow with copied tokens or non-interactive credential workarounds.
- Publish with `npm publish`, then push the release commit and version tag to `origin main`.
- The `postpublish` script deploys the Worker, so a successful npm publication also satisfies the deployment requirement for that release cycle.
- Never publish, deploy, force-push, or bypass failed checks when credentials, permissions, the registry, or the production service are not in the expected state. Diagnose safe in-scope failures; otherwise report the blocker clearly.
