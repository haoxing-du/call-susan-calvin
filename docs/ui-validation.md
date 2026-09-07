# Donation-wide redaction overview

Validated locally on 2026-09-06 with synthetic data. This supersedes the prior default of opening the first session automatically.

- The initial screen shows all 10 standard rule types and their total instance counts across the included donation, including active rules with zero matches. Custom replacements have a separate row. The regex rules and date-window behavior are unchanged.
- Viewing Research update (zero local matches) left the global total at 2. A direct session click retained `scrollY=0` and focus on the session button. The total stays visible while the table collapses; Back to donation overview restores the complete table without changing inclusion.
- Excluding Demo build failure reduced the donation total from 2 to 0; reincluding it restored 2. Global email-rule disablement produced Off / 0 of 1 and a total of 1. Excluding the individual email value produced Some excluded / 0 of 1. Adding a custom redaction immediately added 1 to the custom row and the global total.
- Custom global rule controls work without any session open. Individual value controls are labeled and explicitly describe their scope across included sessions. Category re-enablement clears that category's value exclusions.
- The new regression test aggregates 1,002 occurrences across 501 included sessions, verifies bounded rule metadata, active zero-match rules, custom add/reset, inclusion changes and unredacted mode. `npm run check`: all 35 tests and syntax checks for 21 files pass.
- The overview and custom controls were inspected at 1280 x 900 and 320 x 900. At 320 px the table stayed inside the viewport; compact column headings avoid broken words. Temporary viewport overrides were reset.

Not verified: actual screen-reader speech, mobile Safari focus zoom, RTL, forced colors, true 200% browser zoom, production donation transmission, and a new 100x volume benchmark. The existing large-review tests and bounded session/message rendering remain in place.

# Interface fixes in 0.2.3

Validated locally on 2026-09-06 with synthetic data only. This covers all eight HIGH and MEDIUM findings from the whole-package interface review of 0.2.2. The existing paper theme, compact desktop typography, and bounded pagination remain.

| Finding | Resolution |
| --- | --- |
| Unnamed redaction controls | Native labels name category checkboxes, individual matches, and the custom-pattern field. Category controls sit inside the disclosure rather than competing with its summary action. |
| Input contrast | Input borders and placeholders use the existing muted color, #5f5d67 on #fbf8f1, at 6.10:1 contrast. |
| Startup errors without recovery | Catalog errors offer Retry loading sessions and restart instructions. CLI no-session errors suggest a wider date range; receipt errors suggest the list command. The common error prefix no longer incorrectly describes every failure as startup. |
| Lost custom redactions | Session-specific patterns survive selection, ordering, mode and automatic-rule changes in server memory. Other modes suspend them with an explicit notice. Reset affects only the displayed session and preserves automatic rules. Patterns are reapplied after automatic redaction; the UI asks donors to review rule changes. |
| Session-click page jump | Removed whole-page scrolling and heading focus on session selection. Existing content keeps its height while a replacement loads; actions are disabled until that session is ready. |
| Missing action feedback | Validation binds errors to the pattern input and focuses it. Results and deletion updates have polite status semantics. Rule-toggle focus is restored after rebuilding. Completion focuses the success heading. |
| Search overpromises | The hint now explicitly limits message search to opening messages. |
| Small mobile inputs | Editable inputs and selects compute to 16 px at the mobile breakpoint. |

## Verification

- `npm run check`: 34 tests and syntax checks for 21 JavaScript files pass. The new local-server regression test covers unrelated session deselection, excluded-session previews, reordered selections, standard/unredacted/custom transitions, automatic-rule changes, per-session reset, summary redaction and cross-origin reset rejection.
- `npm pack --dry-run`: reviewed the published file list; only the intended application, server, fixture and documentation files are included.
- Desktop browser at 1280 x 900: a direct accessibility click on Demo build failure left `scrollY` at 0 and focus on the session button. Locator helpers that scroll before acting were not used as evidence of app-driven page movement.
- Custom mode: category and individual-match names appeared in the accessibility tree. Expanding Email addresses preserved its enabled setting; toggling Redact all email addresses changed it independently and restored focus after preparation.
- Applied a synthetic custom redaction, then deselected Research update. The marker remained in the other session. Reloading the page and returning to Custom mode also retained it. Reset restored only that session's custom text and left the disabled email rule unchanged.
- Empty custom input: the field received focus, `aria-invalid=true`, and `aria-describedby=custom-error`. Successful Apply and Reset exposed polite status updates and retained a usable focus target.
- At 320 x 900: search, session number, pattern input and selects computed to 16 px; placeholders and borders computed to the intended muted color. Document width did not exceed the viewport. Viewport overrides were reset after testing.
- A local-only fixture returned a catalog error once, then an empty catalog. Retry loading sessions recovered to No sessions found and focused the empty-state guidance. No external service was contacted.
- Demo donation completed without transmitting data. Focus moved to Donation received. The existing shutdown test verifies the server stops only after completion.

Not verified: actual screen-reader speech, mobile Safari focus zoom, forced-colors mode, RTL, true 200% browser zoom, production receipt deletion, and a new 100x volume benchmark. The bounded rendering and existing large-review tests remain in place; these fixes add no new performance certification.

Approve the fixes to the eight reviewed findings within this coverage.
