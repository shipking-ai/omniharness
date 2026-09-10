# OmniHarness landing page — build brief

**Status: the site is built.** It lives in `landing/` and this brief is kept for
the reasoning behind it, not as a plan. Where the two disagree, the site is the
truth — sections below are annotated where what shipped diverged from the plan.
The one item still genuinely open is the domain (issue #107).

## 1. Positioning

**One line:** The agent harness built for OmniRoute.

**The wedge:** People who run OmniRoute find generic coding agents slow against it — those tools were built for one provider and bolt routing on afterward. OmniHarness inverts that: OmniRoute is the execution layer, everything above it is native to that model. Route once; plan, build, research, or turn a parallel swarm loose.

**Audience:** developers already using OmniRoute (or evaluating it) who live in a terminal and want an agent that is fast on their gateway, transparent about what it does, and genuinely autonomous when told to be.

**Proof points (all real, shipped):**
- One `provider/model` intent out; routing / quota / failover / provider translation stay in OmniRoute. The only integration point is `internal/gateway` — swap it and the whole test suite runs offline.
- Four working modes on `Ctrl+E`: plan · build · research · crazy.
- Permission axis on `Shift+Tab`, independent of mode: manual · accept edits · bypass.
- CRAZY mode fans an independent plan across parallel worker agents (the swarm rail).
- Premium terminal: native-scrollback history, tear-free streaming (DECSET 2026), route ribbon (which provider answered), per-model context meter, per-tool cards with diffs, scoped-trust approvals, input queued during a run, OSC 52 copy / OSC 9 notify.
- Ships as `omniharness-cli` on npm; Go core + headless CLI in the same repo. The web view and the desktop window ship too — both served by the Go binary, both clients of the same HTTP API.

## 2. Page structure (single scroll page)

1. **Hero** — wordmark, one-liner, the animated demo SVG (`.github/assets/omniharness-demo.svg`), primary CTA `npm i -g omniharness-cli` (click-to-copy) + secondary "View on GitHub". Sub-line: "Go core · TypeScript TUI · MIT".
2. **Why** — the wedge, 2–3 sentences, plus the `provider/model` boundary diagram (reuse the ASCII diagram from the README or redraw as SVG).
3. **Modes** — 4 cards (plan / build / research / crazy) with the one-line description + a tiny visual (mode-accent border matching the TUI: plan=blue, build=green, research=teal, crazy=red). Note the `Shift+Tab` permission axis below.
4. **The swarm** — the CRAZY differentiator. Short copy + a still or looping clip of the swarm rail (frame 4 of the demo SVG). "One transcript, many status lines."
5. **The terminal** — a scannable grid of the premium features (6–8 items, one line each) with the "everything on screen makes agent intent, action, and history legible" framing.
6. **Install / quickstart** — the npm one-liner, the three env vars, `omniharness doctor` / `models`. Keep it copy-pasteable.
7. **Architecture** — the two-front-ends-over-one-core diagram; link to `docs/architecture.md`. One paragraph.
8. **Footer** — npm, GitHub, license.

*Shipped instead of the roadmap tease:* a **Surfaces** section — terminal, web,
desktop, all marked "ships today". The page carried "web & desktop coming" for
a while after both had shipped, which is the worst thing a landing page can do:
advertise your own work as unbuilt.

## 3. Design system

The site's palette, aligned to the TUI so the two read as one product.

*Accuracy note:* `npm/src/ui/palette.ts` defines only six of these — `accent`,
`muted`, `success`, `warn`, `error`, `info`. A terminal inherits its background
and body text from the emulator, so `ground`, `surface`, `hairline` and `ink`
exist for the web only and have no counterpart there.

There are now three token sets, and only `accent` (`#2dd4bf`) is common to all
three. The TUI has the six above; this table is the landing page; and
`internal/cli/webui/theme.css` carries a third for the browser surfaces, on a
deeper canvas (`#08090b`) with a five-step surface ladder and slightly
brighter semantics. That divergence is deliberate — the window is a designed
surface rather than a terminal — but it means a colour changed here does not
propagate anywhere, and a change meant to be product-wide has to be made in
all three.

| token | hex | use |
|---|---|---|
| ground | `#0e1016` | page background |
| surface | `#14171f` | cards, code blocks |
| hairline | `#262b38` | borders |
| ink | `#c8cdd9` | body text |
| muted | `#8b93a7` | secondary text |
| **accent (teal)** | `#2dd4bf` | primary accent, links, CTA |
| info (blue) | `#56b6ff` | user / input |
| success (green) | `#8fd66f` | build mode, done states |
| warn (amber) | `#e6b955` | accept-edits, fallback |
| error (red) | `#f2637e` | crazy mode, bypass, swarm |

- **Dark-first**, single visual world (the terminal). A light theme is optional, not required — if added, derive from `LIGHT_TRUE` in the same file.
- **Type:** UI-monospace for anything that represents the TUI (hero, code, mode/perm chips); a clean humanist sans for prose (system stack or one Google font — Inter is fine here since the rest of the page is deliberately terminal-flavoured, or pick something with more character). One display weight, restrained.
- **Motion:** the hero demo already loops. Elsewhere: scroll-reveal at most, nothing that competes with the demo. Respect `prefers-reduced-motion`.
- **Chrome language:** rounded 1px borders in the relevant accent colour, matching the TUI's `borderStyle="round"` panels. No drop shadows beyond a faint window shadow on the hero.

## 4. Assets on hand

- `.github/assets/omniharness-demo.svg` — animated 4-frame terminal cast (idle → Shift+Tab to bypass / Ctrl+E to crazy → planning → swarm done). Self-contained, inline fills + SMIL. This is the hero.
- Real TUI reference frames: run the capture in the repo (`node --test` harness renders `<TerminalInterface>` to a fake stdout) — see the `swarm-integration` / `modes` tests for the pattern.
- `docs/architecture.md` — topology + package layout + the integration-boundary rationale.
- README copy — reusable for sections 2, 5, 7.

## 5. Tech constraints / choices (to decide)

- **Host:** GitHub Pages from `/docs` or a `gh-pages` branch is the zero-infra option; Vercel/Netlify if a framework is wanted. Static either way.
- **Stack:** plain HTML + one CSS file is enough for a single scroll page and keeps it fast. Astro if component reuse or MDX is wanted. No SPA framework needed.
- **Domain:** still undecided, and it is the last thing blocking the social card. `og:image` and `twitter:image` are relative, so Slack, Discord and iMessage unfurl correctly and X does not; `og:url` is absent. One decision makes those absolute and closes issue #107.
- **Analytics:** privacy-preserving only, or none.
- **The npm version badge / install string** should read from `omniharness-cli` at build time so it never goes stale.

## 6. Open questions for the owner

**Still open:**

- Domain + hosting preference — the only one blocking anything (issue #107).

**Settled by what shipped:**

- *Brand:* the OmniHarness teal palette is the identity.
- *Light theme:* no. Dark only.
- *Playground / asciinema:* neither. A real `omniharness doctor` run was
  recorded and rendered as a self-contained animated SVG with CSS keyframes —
  it needs no player and no CDN, and degrades to a finished still frame under
  `prefers-reduced-motion`. The generator redacts the masked key and the
  operator's home path, because a masked key still leaks its last four
  characters and a persistence path carries an account name.
- *Roadmap section:* moot. Web and desktop shipped, so the section became
  Surfaces.
