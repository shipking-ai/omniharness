# OmniHarness landing page

Static HTML/CSS/JS — no build step. Vercel project root = this `landing/` directory.

## Dev

```
npx serve .        # or: python -m http.server 3000
```

In Claude Code, run `preview_start` with name `landing`.

## Design tokens

All CSS custom properties live in the `:root` block near the top of `index.html`.
Pull from `npm/src/ui/palette.ts` to keep site and TUI in sync:

| var        | dark hex  | role                         |
|------------|-----------|------------------------------|
| --accent   | #2dd4bf   | teal — primary brand         |
| --info     | #56b6ff   | blue — user/input            |
| --success  | #8fd66f   | green — build mode / done    |
| --warn     | #e6b955   | amber — accept-edits         |
| --error    | #f2637e   | red — crazy mode / bypass    |

Light theme is the `[data-theme=light]` block. OmniRoute brand shift is `[data-brand=omniroute]`.

## WebGL

The hero uses Three.js `0.161.0` loaded from `esm.sh`. The particle network (`N=170` nodes)
animates on a Three.js scene rendered into `#bg-canvas`.
To swap accent color for theme/brand changes: `accentColor()` reads `--accent` from CSS each frame.

It lives in `assets/hero-bg.js`, imported dynamically inside a `try/catch`, and it must
stay that way. It is the page's only third-party dependency and it is pure decoration:
when it shared a module with the rest of the JS, an unreachable `esm.sh` aborted that
module and left all 24 `.reveal` sections at `opacity:0` — every section below the hero
invisible, with the version badge stuck on its stale literal. Anything the page actually
needs belongs in the plain `<script>` below it, which no CDN can stop.

## Sections

| id             | what it is                              |
|----------------|-----------------------------------------|
| `#hero`        | WebGL canvas + CTA + demo SVG           |
| `#why`         | Wedge copy + architecture pre           |
| `#modes`       | 4 mode cards + perm-axis note           |
| `#swarm`       | CRAZY differentiator                    |
| `#terminal`    | 8-feature grid                          |
| `#install`     | 5-step quickstart                       |
| `#playground`  | Terminal typewriter demo + asciinema CTA|
| `#architecture`| Repo tree diagram                       |
| `#coming`      | Web/desktop tease + notify form         |

## The doctor recording (assets/doctor.svg)

A real recording, not a mock. `scripts/record-doctor-cast.py` runs `omniharness
doctor`, captures every line with the moment it actually appeared, and writes a
self-contained animated SVG:

```
python scripts/record-doctor-cast.py capture.json landing/assets/doctor.svg
```

An SVG rather than an asciinema cast because a cast needs a player, and the
player needs a CDN or a vendored bundle — this page depends on neither. The CSS
animation runs anywhere with no JavaScript, and under
`prefers-reduced-motion` it shows the finished output instead of an empty box.

**Two things are redacted and must stay redacted:** the masked API key still
leaks the last four characters of a live credential, and the persistence path
carries the operator's account name. The generator does both; check its
`REDACTIONS` before re-recording, and grep the result for your own username
before committing it.

## Deployment (Vercel)

1. In Vercel dashboard: create new project → import the GitHub repo
2. Set **Root Directory** = `landing`
3. Framework preset = **Other** (no build command)
4. Deploy — that's it. Auto-deploys on push to `main`.

The version badge (`#ver-badge`) reads the published version from the npm registry
on load; the literal in the markup is only the offline fallback, so there is nothing
to bump by hand.
