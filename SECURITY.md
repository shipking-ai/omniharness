# Security

## Reporting

Use [private vulnerability reporting](https://github.com/shipking-ai/omniharness/security/advisories/new).
It is enabled on this repository, so the report stays between you and the
maintainers until there is a fix. Please do not open a public issue for
anything exploitable.

Include what you did, what happened, and what you expected. A failing test is
the fastest possible report.

Expect an acknowledgement within a few days. This is a small project without a
staffed security rota, so that is a best effort rather than an SLA.

## What this thing is

An agent harness runs a language model's decisions as commands on your machine.
It reads and writes files, runs shell commands, and talks to whatever MCP
servers you have configured. The security posture is about **bounding** that,
not eliminating it. Anyone running it should understand that the model chooses
the actions and the harness decides which of them are allowed.

## In scope

These are guarantees. If you can break one, that is a vulnerability:

- **Workspace confinement.** Filesystem tools cannot read or write outside the
  workspace root. The check follows symlinks, on both existing paths and paths
  about to be created, and resolves the root the same way it resolves the
  target.
- **Credential isolation.** No subprocess inherits `OMNIROUTE_API_KEY`,
  `OMNIROUTE_MGMT_TOKEN`, `OMNIHARNESS_API_KEY` or `ROUTER_API_KEY`. That list
  cannot be disabled from config.
- **The policy gate.** A tool whose risk class is configured `ask` does not run
  without approval; `block` does not run at all. An unrecognised risk class
  requires approval rather than defaulting to allow. An approval that times out,
  errors, or has no UI attached is a denial. Critical-risk tools are refused
  outright and cannot be downgraded to a prompt.
- **`shell_allowed = false`** means no shell, including by way of another tool.
  That covers verification: the evaluators that run a project's own code
  (`npm test`, `npm run build`, `npm run lint`, `go test`, `cargo build`,
  `cargo test`, `pytest`, and the `git status` behind the diff check, which
  runs commands from the repository's own git config) are skipped and
  recorded as not assessed while it is false. The model can write every file
  those commands read, so running them would be running a script it chose.
  `go build` and `go vet` still run; they compile and analyse without
  executing workspace code.
- **The file tools do not write inside `.git`.** git runs commands named in a
  repository's own config (`core.fsmonitor` on a plain `git status`,
  `diff.external`, filter drivers), so a writable `.git/config` would turn an
  approved `git status` into any command, and the approval prompt could not
  show it. `write_file` and `edit_file` refuse any path with a `.git`
  component, in every spelling a filesystem treats as one (any case, trailing
  dots or spaces, an NTFS stream suffix, the `GIT~1` short name, zero-width
  characters), and through symlinks. Reading `.git` is still allowed.
- **Cost and token budgets** stop a run at the ceiling, including a run that
  would exceed it in a single turn.
- **The local HTTP API** (`omniharness serve`) rejects any request carrying an
  `Origin` header or a non-loopback `Host`, so a web page cannot drive it
  through DNS rebinding.
- **Secrets in the interface.** An API key entered in the TUI is masked to its
  last four characters and is never written to the transcript, the event log or
  the session store.

## Known and out of scope

Stated plainly, because a limitation you know about is a decision and one you
do not is a trap.

**There is no operating-system sandbox. OmniHarness assumes a trusted
workspace and a trusted machine.** Everything it spawns (a shell command, a
`[[commands]]` tool, an MCP server, an evaluator, `git`) runs as you, with
your filesystem and your network. Workspace confinement is enforced by the
file tools themselves, not by the kernel: a shell command can read `~/.ssh`,
edit `~/.omniharness.toml` to loosen the next run's policy, or open any
connection your machine can. The policy gate runs in the same process and
decides which tool calls happen; it does not constrain a program once it is
running. Some other agent CLIs confine subprocesses by default (Landlock and
seccomp on Linux, Seatbelt on macOS). This one does not yet. Until it does:

- Turning on `shell_allowed` hands the model code execution as you, gated
  only by the approval prompt. Together with `--yes` or `bypass`, there is
  no gate at all.
- To work on a repository you do not trust, run OmniHarness inside a
  container, VM or dev container, and give it only the credentials the task
  needs.

**Repository instruction files are instructions.** `AGENTS.md`, `CLAUDE.md`
and `GEMINI.md` in the workspace are read into the agent's prompt. A repository
you did not write can use them to steer the model, the same way any file it
reads can. The policy gate still applies.

**Third-party credentials reach subprocesses.** `GITHUB_TOKEN`,
`AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN` and the rest are inherited by design — an
agent asked to open a pull request or publish a package needs them. Strip them
with `policy.secret_env`:

```toml
[policy]
secret_env = ["GITHUB_TOKEN", "AWS_*", "*_TOKEN"]
```

**MCP tool descriptions are prompt injection.** An MCP server describes its own
tools, and those descriptions go to the model as instructions. A hostile server
can say anything. Sanitising does not fix this; it is a property of the
protocol. Run MCP servers you trust. A server cannot take over a built-in tool
by claiming its name — that much is enforced and tested — but it can lie about
what its own tools do.

**A model can be talked into things.** The policy gate constrains what a tool
may do, not what the model may be persuaded to want. Content the agent reads —
a file, a web page, a tool result — can contain instructions. That is why the
gate is on tools rather than on intent.

**`--yes` and `bypass` mean what they say.** Both disable the approval prompt.
They are for sandboxes and CI, not for a workstation with credentials on it.

**The default cost ceiling is $5**, not zero risk. It bounds a runaway loop; it
does not make the harness free.

## Versions

Fixes land on `main` and publish immediately. There is no backport branch — the
supported version is the latest release.

| Version | Supported |
| ------- | --------- |
| latest  | yes       |
| older   | no        |
