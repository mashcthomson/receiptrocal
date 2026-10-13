# Receiptrocal redesign, astra

## Sources used

Research: 13-10-26, 15:13 to 15:16 AEDT, before implementation and within the 10-minute limit. Spine recall was checked with `since: 2026-10-12`; older history was treated as background. Spine knowledge located the UI and responsive skill cards. `cs find` resolved the flattened paths in the brief to the following readable corpora paths:

- `altra/nextlevelbuilder__ui-ux-pro-max-skill/.claude/skills/ui-ux-pro-max/SKILL.md`: accessibility priorities, 44 px controls, focus visibility, semantic status colors, responsive layout. Also searched its local typography data through corpora search. Guidance was read through `cs`; no skill runner or packages were installed. The final palette is adapted from the references below, not claimed as generated search-script output.
- `incoming/mac-corpus-incoming/github-survey-20260901/clones/full-skills/vendor/wshobson_agents/plugins/ui-design/skills/responsive-design/SKILL.md`: fluid grids, content breakpoints, readable mobile forms and overflow checks.
- `incoming/mac-corpus-incoming/github-survey-20260901/clones/full-skills/vendor/davila7_claude-code-templates/components/skills/creative-design/mobile-design/SKILL.md`: touch targets, visible feedback and error states. Applied its browser-relevant touch principles; this is an existing browser app, not a native iOS/Android build.
- `altra/VoltAgent__awesome-design-md/design-md/revolut/DESIGN.md`: strong outcome typography and contrast between content surfaces.
- `altra/VoltAgent__awesome-design-md/design-md/wise/DESIGN.md`: warm neutral canvas, restrained lime action color and dark financial text.
- `altra/VoltAgent__awesome-design-md/design-md/linear.app/DESIGN.md`: quiet borders, precise spacing and compact technical metadata.
- `altra/ant-design__ant-design/components/result/index.tsx`: result composition around an icon, outcome title, explanatory text and actions. No source code or assets copied.
- `altra/Manavarya09__design-extract/README.md` and `altra/MengTo__threeui/README.md`: reviewed local component/design-system approaches. Neither was installed or vendored; the existing buildless app remains dependency-free.

## Result

A light payment verification desk with deep green typography, a sage canvas and one lime primary demo action. A new original SVG combines a receipt/check monogram with a wordmark. The heading is “A receipt. A clear answer.” Demo and live remain distinct, with prominent synthetic and RPC provenance labels.

The corrected spelling from the brief modified at **15:17:37 AEDT** was re-read live at **15:18:06 AEDT**. Product spelling is defined once per affected product file: a browser `PRODUCT_NAME` constant, one HTML title, one SVG wordmark, one Markdown title/name, package name, and constants for server/MCP/merchant copy. CLI copy has one literal. MCP tool descriptions and server display title use the new name.

All existing features remain: six selectable scenarios, Run all cases, finalized live RPC checks, session history, lamport hints, form validation and reset, reasons, complete receipt details, address/signature copy, parsed instruction evidence, raw JSON disclosure, JSON copy/download and limitations. Verdicts are now large text headings with distinct icons and semantic colors. Expected and observed amounts sit directly below them.

Mobile uses a single column, sticky mode tabs, 44 px or larger controls, stacked amounts and evidence rows, and wrapping addresses/JSON. Selecting a case or completing a live check scrolls to and focuses the result on small screens. A return link leads back to the input panel. Keyboard case focus survives table rerenders. Pending checks clear previous results, and late demo responses cannot replace a different selected case. Live failure leaves an explicit “No verdict recorded” result.

No verifier or RPC implementation changed. `app/lib/`, fixtures and existing tests are untouched. Route names, tool IDs, MCP server identifier, protocol headers, ledger keys and the evidence format identifier remain stable. Non-UI server, merchant and CLI edits only change human-facing branding. No npm dependencies, CDN assets, external fonts, payment calls, sign-ins, push or publication.

## Validation

- **145 tests passed, 0 failed** using `cd app && npm test`. Final log: [astra-tests.log](../evidence/astra-tests.log), written **13-10-26 15:31:24 AEDT**. The initial sandbox run could not bind local ports; the authorized run outside that sandbox passed.
- Local preview launched with `PORT=4322 npm start`, at `http://127.0.0.1:4322/`.
- Existing Flatpak Chrome, isolated profile `evidence/browser-profile`, per-run filesystem permission only. No browser installed and no operator profile used. Background networking, component updates and sync disabled.
- Own CDP interaction checks completed **13-10-26 15:30:48 AEDT**: [browser results](../evidence/astra-browser-check.json), [reproducible Node script](../evidence/astra-browser-check.mjs). Uses Node's built-in WebSocket, no added package.
- Tested **1440×900, 390×844 and 360×800**. No horizontal page overflow in initial, result, expanded raw evidence or live form views. All measured visible interactive controls were at least 44×44 px. Chrome's 15 px scrollbar is included in the viewport dimensions.
- All six fixture outcomes and Run all cases exercised at every size. One-lamport underpayment stays exactly `0.499999999 SOL`. Synthetic provenance remains visible. Mode changes remove the other mode's result. Empty live validation focuses the first invalid field; Clear resets validation.
- Real browser clipboard copy and file download exercised. Downloaded JSON parsed and verified to contain `synthetic: true`, its notice, and unchanged machine verdict. No fixture is passed off as real RPC evidence.
- Arrow/Home keyboard mode navigation and Enter case activation passed. `aria-live="polite"` retained on results, visible focus rings, decorative SVGs hidden from assistive technology and reduced-motion support.
- Computed contrast check covered 129 text elements in the desktop demo/result state. No failures; minimum measured ratio **4.58:1**. A decorative header divider was darkened after the first check. This is a targeted contrast check, not a full accessibility certification.
- A deliberately intercepted **simulated RPC 502** remained an error in the form and session history; no verdict or demo fallback appeared. Browser validation made no real payment or external RPC call. The unchanged RPC behavior is covered by the existing test suite.
- No browser JS exceptions. The browser page's recorded request origin was only `http://127.0.0.1:4322`.
- `git diff --check` passed. Live diff review confirmed no changes to core verification/RPC files.

Supplemental orchestrator evidence was read from `evidence/orch-browser-check.json`, completed **15:24:32 AEDT**, and its file timestamp was checked live at **15:25:01 AEDT**. It independently records the three viewport sizes, synthetic outcomes, exports, empty form validation and simulated live failure. Those orchestrator artifacts are left in place and are not included in astra's commit.

## Screenshots

Own screenshots were captured from the running app and visually inspected:

- [Desktop, 1440×900, synthetic matched result](../evidence/redesign-astra-desktop.png)
- [Mobile, 390×844, initial case selection](../evidence/redesign-astra-mobile.png)
- [Mobile, 390×844, synthetic result](../evidence/redesign-astra-mobile-result.png)
- [Desktop, synthetic mismatch](../evidence/redesign-astra-desktop-mismatch.png)
- [Desktop, initial state](../evidence/redesign-astra-initial-desktop.png)
- [Desktop, live form](../evidence/redesign-astra-desktop-live.png)
- [Mobile, live form](../evidence/redesign-astra-mobile-live.png)
- [Desktop, simulated RPC error](../evidence/redesign-astra-live-error.png)

## Known gaps and handoff

No physical-phone, Safari or screen-reader pass was performed. Browser checks use the installed desktop Chrome engine at the requested viewport sizes. No new genuine onchain-success claim is made. Existing limitations remain visible: SOL System Program transfers only, trusted RPC data, process/session-local replay protection, no custody and no production-security certification.

Branch: `redesign-astra`. The report, own screenshots, own browser-check script/results and final test log accompany the implementation commit. Browser profile files, orchestrator evidence and the supplied brief are excluded. Preview port is **4322**. No extra agents were used. No push or publication.

## Round 2, 13-10-26

Final implementation and visual review completed **16:10 AEDT** on `redesign-astra`. This section supersedes round 1 where behavior changed. Reused the original UI/corpora references above, with no extended research or additional agents. Re-read the corrected order (mtime **15:54:33 AEDT**) live at **15:55:30 AEDT**. The requested bottom navigation was explicitly cancelled before implementation; the original responsive Demo/Live tabs remain.

### Changes

- Added the floating bottom-right **Website / Phone** segmented switch with local SVG icons, labels, `aria-pressed`, visible keyboard focus and at least 44 px touch targets. It is compact enough to leave the observed amount and lamport text readable at 1440×900.
- Website retains the full app. Phone loads the same app from `/?embed=1` inside a centered rounded frame on the sage backdrop. At a 900 px window height the iframe viewport is exactly **390×844**. Frame height is capped by `calc(100dvh - 32px)`; at a 700 px window height the iframe is **390×644**, still 390 px wide.
- The display choice persists in `localStorage`, protected by `try/catch`. Embedded documents ignore the remembered choice and hide their own switch/frame, preventing recursive preview loading. At widths **600 px and below**, the switch is hidden and the normal responsive app always displays, even with Phone remembered. Embedded scrollbars are hidden while scrolling remains usable.
- Added automatic dark styling via `prefers-color-scheme`, including the SVG wordmark, controls, evidence, fixture notices and focus treatment. Dark Skip to content now uses dark text on lime. No external fonts/assets or dependencies.
- Added the invoice → transaction → verdict workflow strip and a clear SOL verification pitch. On phones the workflow uses readable stacked rows. Phone honesty labels, case expectations and amount labels/lamports are at least 12 px. Sticky tabs mask the stray strip of content below them.
- Desktop scenario rows align the scenario/invoice, amount and verdict. Verdict cards retain large status headings and explicit provenance. The footer contains the exact link `https://github.com/mashcthomson/receiptrocal` and **“Read-only. No wallet, no keys.”**

### HTTP boundary and embedding

The only accepted Host/Origin pairs are:

| Host | Origin, when supplied |
| --- | --- |
| `127.0.0.1:<actual server port>` | `http://127.0.0.1:<actual server port>` |
| `localhost:<actual server port>` | `http://localhost:<actual server port>` |
| `receiptrocal.monishc.com.au` | `https://receiptrocal.monishc.com.au` |

Host and Origin are compared exactly. Origin remains tied to its matching Host; the public Origin cannot authorize a loopback Host or vice versa. No forwarding header is trusted. Subdomains, lookalikes, appended ports, trailing dots, wrong schemes, unlisted hosts and invalid origins are rejected. Origin-free navigation remains supported as before.

CSP now explicitly uses `frame-src 'self'`. Only a GET of the root document with `embed=1` changes `frame-ancestors` to `'self'`; the ordinary page, other query values and API routes retain `'none'`. No arbitrary frame origins are allowed. The server still binds loopback, and RPC/core verification semantics are unchanged.

Added real HTTP boundary tests using explicit Host headers, including a truly empty Host with Node's `setHost: false`. Tests exercise accepted public and loopback requests, rejected Host/Origin combinations, ignored forwarding headers, successful `/?embed=1` serving and the narrow CSP exception.

### Validation and evidence

- **175 tests passed, 0 failed**. [Round 2 test log](../evidence/astra-round2-tests.log), written **16:03:14 AEDT**, includes all 145 original tests plus the new boundary cases. Subsequent product changes were the bounded CSS/readability refinements and the embed root styling marker; final browser checks cover those changes.
- [Own browser results](../evidence/astra-round2-browser-check.json), completed **16:09:38 AEDT**, and [reproducible Node/CDP script](../evidence/astra-round2-browser-check.mjs). Existing isolated Chrome on 9322 was reused, with no browser installation.
- Light and dark at **1440×900, 390×844 and 360×800**: no page overflow, no JavaScript exceptions, no visible interactive targets below 44×44 px, six synthetic outcomes, live validation/reset, raw evidence layout and correct footer destination. Status text contrast was checked for matched, mismatch, duplicate and needs-review states, plus form errors. Matched-state minimum contrast was **4.58:1 light** and **4.64:1 dark**, including the corrected skip link.
- Website/Phone keyboard Enter activation, both persisted choices after reload, real iframe media queries, inherited dark mode, 390×844 viewport, short-window sizing, usable embed scrolling, no nested loaded iframe, real-phone override and storage-denial fallback all passed.
- Browser network capture recorded only the local preview origin. No genuine payment or public deployment acceptance is claimed.
- Preview server PID **1839045** was verified as `node server.mjs` with cwd `/home/mash/mac/laptop-work/rr-redesign-astra/app` before stopping that process only. The updated server was restarted with `PORT=4322 npm start` for videos.
- Opus review report mtime **16:05:03 AEDT** was read and compared with the live source at **16:07:15 AEDT**. Its bounded visual notes were applied. The claim that the original frame failed to fit a 900 px window was not adopted; own measured 390×844 viewport and screenshots verify that size. The short-window cap was added and tested separately.

Selected screenshots, captured from the running app and visually inspected:

| View | Light | Dark |
| --- | --- | --- |
| Desktop matched result | [1440×900](../evidence/round2-astra-light-1440-result.png) | [1440×900](../evidence/round2-astra-dark-1440-result.png) |
| Phone-width result | [390×844](../evidence/round2-astra-light-390-result.png) | [390×844](../evidence/round2-astra-dark-390-result.png) |
| Small phone initial view | [360×800](../evidence/round2-astra-light-360-initial.png) | [360×800](../evidence/round2-astra-dark-360-initial.png) |
| Interactive phone frame | [390×844 iframe](../evidence/round2-astra-light-phone-preview.png) | [390×844 iframe](../evidence/round2-astra-dark-phone-preview.png) |
| Short-window phone frame | [700 px window](../evidence/round2-astra-light-phone-preview-short.png) | [700 px window](../evidence/round2-astra-dark-phone-preview-short.png) |
| Desktop mismatch | [Mismatch](../evidence/round2-astra-light-1440-mismatch.png) | [Mismatch](../evidence/round2-astra-dark-1440-mismatch.png) |
| Footer and exact GitHub link | [Footer](../evidence/round2-astra-light-1440-footer.png) | [Footer](../evidence/round2-astra-dark-1440-footer.png) |

Additional initial, result, mismatch, live-form and footer captures for all three sizes are in `evidence/round2-astra-*.png`. Orchestrator artifacts remain untouched and are excluded from this commit.

### Remaining boundaries

No physical-phone, Safari or assistive-technology session was performed; this remains a Chrome viewport and keyboard/contrast check. Website and Phone render separate instances of the same app, so their current selection is independent. Display preference persists, not payment data. No tunnel configuration, deployed copy, main worktree, push or merge was touched. The public deployment target and its final acceptance belong to the orchestrator handoff. All existing payment, synthetic-fixture, RPC-trust and replay-protection limitations remain visible.
