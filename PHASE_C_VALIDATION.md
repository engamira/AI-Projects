# Phase C: validation of the multilingual redesign

Date: 2026-10-29. Written for the product owner. Every line below says which automated check proves it; "walk-through" is `e2e/walkthrough.ts`, which runs the whole workflow with English, Arabic and German and the UAE / VIP rules and saves screenshots to `validation/phase-c/` (ignored by git; run `npm run e2e` to recreate).

## The 15 acceptance scenarios

| # | Scenario | Proven by |
|---|---|---|
| 1 | `all languages` loads the configured registry (26) | `emails.test.ts` (registry has 26, English first, Italian present); `e2e/languages.ts` ("all languages" loads the 26) |
| 2 | English-Email can be created, saved and cloned into German-Email | `e2e/languages.ts`, walkthrough |
| 3 | The German clone keeps blocks and rules and shares no state | `emails.test.ts` (new ids, same rules, edits to one never reach the other); `e2e/languages.ts` |
| 4 | A saved German-Email appears everywhere | walkthrough: Segments list, derived segments, Audiences, Preview selector, Versions chips, QA list (screens 01, 03, 04, 05) |
| 5 | Language selection makes baseline test audiences | `rules.test.ts`; walkthrough (en-, ar-, de-Audience) |
| 6 | UAE / VIP show and hide rules make extra audiences | `rules.test.ts` (positive, negative, hide, de-duplicated, capped); walkthrough: UAE VIP, Not UAE and UAE audiences in each language |
| 7 | Preview uses the same rules as Segments and Audiences | `submissions.test.ts` (shown / hidden with the reason per block); walkthrough: UAE VIP Arabic shows the VIP block and hides the standard offer, Not UAE the reverse (screens 05, 06) |
| 8 | Each language has independent revisions | `emails.test.ts`, `submissions.test.ts`, `e2e/languages.ts` |
| 9 | The builder can send an older saved revision to QA | `submissions.test.ts`, `e2e/languages.ts` |
| 10 | With nothing chosen, the latest saved revision is sent | same |
| 11 | A revision saved during QA does not change the one under review | `submissions.test.ts` ("never includes unsaved changes, and saving a newer revision does not change what is under review") |
| 12 | Findings can be sent to the builder, corrected and retested | `qa.test.ts`, `e2e/qa.ts`. **Note:** these are automatic checks. AI suggestions are not enabled (decision 2026-10-28) |
| 13 | Approval applies to the exact reviewed revision | `qa.test.ts` (approval row names revision 3 only; the database refuses author / sender approvals); `e2e/qa.ts` |
| 14 | Global ignores are narrow, reversible, permission-controlled and audited | `qa.test.ts` (fingerprint-specific by default; global needs `qa.suppress_global`; revoke brings findings back; rules cannot be deleted; activity history); `e2e/qa.ts` (App Settings) |
| 15 | Empty states, duplicates, invalid input, deletion, permissions, responsive layouts | duplicates, invalid languages, deletion, permissions: `emails.test.ts`, `submissions.test.ts`, `qa.test.ts`; empty states and 390 px layout of all seven tabs: walkthrough |

## Consistency pass (Coral Night kept)

Checked in the walk-through: arrow keys, Home and End move between tabs; hover and state changes take about 170 ms and none when "reduce motion" is on; dark mode follows the device (screens 10, 11); none of the seven tabs scrolls sideways at 390 px (screens 12). Status colours (shown / hidden, ok / warning / error, info) are now theme tokens, so they read in light and dark. Focus rings, disabled states and hover states are one set for every control.

## Migration notes

- Four additive migrations: 0010 (languages, language emails, revisions), 0011 (derived segments and test audiences), 0012 (QA submissions), 0013 (QA runs, findings, corrections, suppression rules, approvals). Nothing is deleted or rewritten by them.
- An email made with the previous editor stays as it was until a Builder presses **Upgrade to the multilingual editor**: the Default becomes English-Email with its saved versions as revisions, each language email becomes its own email, and per-segment copies are kept read only (`campaign.legacy_variants`). Safe to repeat.
- New emails use the multilingual editor by default (a tick box on the Emails page selects the previous one).
- `npm run backup-content` writes a local safety copy of the content tables.

## Known limits

- **Automatic checks only.** They look at settings, blocks, links (format only), pictures, personalization, rules, translation signs, the built email and its size. They do not open links, measure layout in a real browser, or show the email in Outlook, Gmail or other apps. Each run lists what it did not cover. AI suggestions are not enabled; a separate place exists for them.
- **Translation signs are heuristics:** copy identical to English, the wrong writing system, and leftover English words. A person must still read the translation.
- **Test audiences** are capped at 60 per language; the Segments tab says so when the cap is reached.
- **Starter layouts** are English; translating a clone means editing every block (the QA "untranslated copy" check flags what was left).
- **Right to left:** Arabic emails mirror columns and alignment and carry `dir="rtl"`. Other right-to-left languages are not in the registry. Hebrew is not included; Italian was added as the 26th language.
- **Sending** (M7) is not part of this redesign. When it arrives it must send one approved revision per language; an email is ready to send when every enabled language has an approved revision.
- **Old screens** (the previous editor, per-segment copies, the mapping panel) still exist for older emails and are not part of the new workflow.
