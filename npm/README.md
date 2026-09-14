# omniharness-cli

**OmniHarness** — the agent harness built for [OmniRoute](https://omniroute.ai).
Route once, run anywhere: plan, build, research, or turn a swarm loose.

This package ships the interactive **terminal UI** (Ink/React). The orchestration
core lives in the [Go source tree](https://github.com/shipking-ai/omniharness), along with
a headless CLI, a loopback HTTP API (`omniharness serve`) and a desktop window
(`omniharness desktop`) — all four front-ends over the same runtime.

```bash
npm install -g omniharness-cli
omniharness            # launch the TUI in the current working directory
```

| Command | |
|---|---|
| `omniharness` | launch the interactive TUI |
| `omniharness doctor` | check the gateway connection + auth, safely (key is masked) |
| `omniharness models` | list the routing catalog — combos, `auto/*`, providers |
| `omniharness update` | self-update to the latest npm release |
| `omniharness --version` / `--help` | version / usage |

Everything else happens inside the TUI.

## Connect to OmniRoute

| Variable | Meaning |
|---|---|
| `OMNIROUTE_URL` | Gateway endpoint (default `http://127.0.0.1:20128`) |
| `OMNIROUTE_API_KEY` | `Authorization: Bearer <key>` on every request — held **in memory only**, never written to config, sessions, logs, or telemetry |
| `OMNIROUTE_MGMT_TOKEN` | Management token (`manage` scope) — when set, OmniRoute's MCP tools are discovered and offered to the agent |

If `OMNIROUTE_API_KEY` is unset, the TUI asks for it on launch and keeps it in
memory only. It is redacted from all output.

## Inside the TUI

The default screen is the task, the answer, the work in flight and the composer.
Everything else is one keystroke away rather than permanently on screen.

- **`Ctrl+K` — the command palette.** Every command, mode, permission, engine and
  view, searchable. The same commands work typed: `/route`, `/mode build`,
  `/save today`.
- **`Ctrl+L` — cycle views**: run → agents → plan → route → sessions. `Esc`
  returns to the run. The composer never moves.
- **Modes** (`Ctrl+E` cycles): `plan` · `build` · `research` · `crazy`. Crazy mode
  auto-approves every call and fans an independent plan out across parallel
  worker agents, which the **agents** view lists one row apiece.
- **Native scrollback is the history** — settled turns are written into your
  terminal's own buffer and are still there after you quit.
- **The route view** carries the provider, model, route profile, failover chain,
  measured latency, tokens, spend and context use. Anything the gateway did not
  report is absent, never shown as a zero.
- **Approvals** land in a full-width band above the composer: `y` once · `n` deny
  · `a` always · a digit picks a trust scope.
- Tool output collapsed by default (`Ctrl+T` opens the newest), diffs rendered as
  diffs, input queued during a run, `Ctrl+Y` clipboard copy over OSC 52, session
  resume, prompt history.

Slash commands: `/run` `/agents` `/plan` `/route` `/sessions` `/model`
`/mode <name>` `/perms <name>` `/clear` `/save <name>` `/forget <name>`
`/resume <name>` `/attach <files>` `/find <text>` `/copy` `/cancel` `/help`
`/quit`.

Set `OMNIHARNESS_ASCII=1` for plain-ASCII markers; `NO_COLOR` and
`OMNIHARNESS_THEME=light` are honoured.

## Notes

- Node.js 20 or newer.
- Publishing is automatic: every push to `main` runs
  `.github/workflows/publish.yml`, which runs the TypeScript suite, builds, and
  publishes via **npm trusted publishing (OIDC)** — no token is stored,
  provenance is attached automatically. The Go suite gates earlier, on the pull
  request (`.github/workflows/ci.yml`). Locally, `scripts/release-npm.sh` does
  the same (`--dry-run` to skip publish; `--minor` / `--major` / an explicit
  version to control the bump).
