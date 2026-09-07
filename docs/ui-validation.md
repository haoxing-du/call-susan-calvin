# Saved custom rule management

Standard and custom redactions share a table with matching group headings, status, and instance columns. Each saved custom pattern has its own row, type label, and Remove action, including rules with zero matches. Plain text and regex replacements use `[REDACTED]`. Existing automatic markers retain their category labels.

- All 40 tests and syntax checks pass. New coverage verifies stable rule IDs, per-rule counts, overlapping patterns, individual removal, later inclusions, Standard mode suspension, snapshot stability after source changes, preservation of other rules, and rollback if removal exposes text that invalidates a remaining expression. The local API test checks individual removal and cross-origin rejection.
- Browser demo: added two rules, verified both pattern/count rows, removed one, and confirmed the remaining row and transcript marker. Removed text returned while automatic email/credential redactions and the other custom rule remained applied.

# Global custom redactions (0.4.0)

Custom text and regex rules now apply across all included sessions. The session picker is removed. Rules also apply to later inclusions; reset clears every custom rule and preserves automatic choices. Older entries below describe previous releases.

- All 38 tests and syntax checks pass. Coverage includes 501-session aggregate counts, later inclusions, mode changes, global reset, cross-origin rejection, immutable session endpoints, and rollback when a pattern fails in a later session.
- Changes are staged on disk one session at a time and committed only after the full bundle succeeds. Reset restores the automatic snapshot without rereading modified source files. A reusable worker keeps custom regex execution off the server thread, with a five-second limit per session and rule. The browser polls progress while donation controls are locked.
- Browser demo: adding a rule from the overview updated the donation-wide count; adding another with a transcript open immediately refreshed its markers. There is no session target picker. Reset restored the original custom-redacted text while retaining email and credential redactions.

# Custom redaction access and occurrence navigation

This update restores custom inputs at the top of Customize mode, including when no session is open. The Apply to session picker makes the target explicit. Applying or resetting a pattern opens the affected transcript; viewing a matched value collapses the form to its visible summary.

- All 37 tests pass, plus syntax checks. The occurrence test uses real synthetic session files and covers repeated matches in the same message, multiple sessions, message 46, invalid positions, cancellation, value exclusions, custom patterns, snapshot stability after source changes, and exclusion of location/context metadata from donations. The local-server test verifies the occurrence endpoint against demo data.
- Browser: opened Customize mode from the initial overview and applied a plain-text custom redaction without first opening a session. The custom count increased and the target transcript showed the marker. Opened a detected email, inspected its highlighted context/message, and left it unredacted from the context checkbox; the preview and totals updated.
- Browser with separate temporary synthetic fixtures: one invoice number appeared in two sessions, at messages 3, 50, and 51. Clicking the number opened occurrence 1 of 3; Next occurrence navigated across sessions to messages 50 and 51 and selected the message page 41–51. The matching message was outlined and the transcript pane scrolled to it. A native click retained the document scroll position (402 before and after).
- At 320 px, document width remained 305 px; desktop layout was checked at 1280 px. Temporary viewport overrides were reset. The real local app and user transcripts were not changed.

# Concise copy and donation-wide matched strings

This update supersedes the per-session match lists described below.

- All 36 tests and syntax checks pass. The new category test covers 501 sessions, aggregation of repeated values, full strings, individual and category exclusions, changed inclusion, zero matches, unredacted mode, cancellation, and bounded summary polling. The local-server test also exercises the category endpoint against demo transcripts.
- Browser checks covered Standard and Customize mode, opening the email category, excluding and restoring its value, restoring checkbox focus after preparation, and viewing a session without changing inclusion or totals. A direct session click kept scrollY at 0; Back to overview restored the expanded category.
- At 320 px, expanded matched strings fit without horizontal page overflow (document width 305 px). The desktop layout was checked at 1280 px. Viewport overrides were reset; no console errors were observed. All browser data was synthetic.

## Plain words; delete repetition

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW | app/index.html:15, app/index.html:23, app/index.html:34, app/app.js:75, app/app.js:384 | Repeated explanations of donation scope, session viewing, read-only messages, timestamps and privacy | Short headings, one donation-wide scope label, compact inclusion/count status, no idle session panel | Removes repeated instructions so controls and results are easier to scan. |
| LOW | app/index.html:48 | Multi-sentence explanation of saved patterns and automatic-rule ordering | One sentence naming the replacement marker and persistence | Keeps the consequence and duration next to the action. |

## Verb-first buttons

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| LOW | app/index.html:53 | Apply | Redact matches | Names the action without requiring surrounding explanation. |

Verification: inspected app/index.html and app/app.js copy, including action labels, mode descriptions, errors and success messages. Listed findings are fixed; no remaining actionable writing findings in this inspected scope.

Approve

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
