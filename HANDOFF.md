# Handoff

Live state of the agent-harness improvement work. **Updated in the same commit as every change.**
Read this top to bottom and you have everything; nothing here depends on a previous session's memory.

| | |
|---|---|
| **Branch** | `claude/vigilant-goldberg-n3koai` (fast-forwarded from `claude/inspiring-hypatia-wx35s3`, which is now stale — work here) |
| **Base** | `main` @ `cca9b4b` (PR #126 merged; base has not moved since) |
| **Head** | see `git log -1`; this file is committed with every change |
| **Unmerged commits** | 16 |
| **Open PR** | none. *The user has not asked for one — do not open one unasked.* |
| **Published** | `omniharness-cli@0.1.122`. Nothing on this branch is released yet. |
| **Gate** | green: `gofmt`, `go vet`, `go test ./...`, `npm run typecheck`, `npm test` |
| **Tests** | 674 Go test functions (`grep -rhc "^func Test" --include=*_test.go internal cmd`; 598 at branch start) · 463 npm tests (from 459) |

---

## Read these first

- **`AGENTS.md`** (repo root) — the authoritative rules. It predates this work. Two of its rules
  have already caught real mistakes here, so treat them as load-bearing rather than boilerplate:
  *a test not watched to fail on the broken version is a guess*, and *never fabricate a number*.
- **`SECURITY.md`** — read before touching `internal/policy`, `internal/envguard`,
  `internal/budget`, or `internal/cli/serve.go`. Several of the commits below touch `policy`.
- **Research report** — the source of the ranked backlog, 4 editions (fourth, 28 Sep, carries the
  corrections below and re-audits the repo at d184e51):
  https://claude.ai/artifact/5gge1j8cfVov9RXCcodZzK
- **Terminal Agents Census** (28 Sep 2026): every terminal coding agent found (437 entries, 40 read
  at the source), compared on sandboxing, approvals, routing and TUI stack, with evidence for 07, 08
  and 09: https://claude.ai/artifact/U13nvZ2pEHHf2z5r3cix8V
  It corrected the research report in two places, now fixed in its fourth edition. The "GPT-5.5 38/37/18 across Codex, OpenCode,
  OpenClaw" figure is not in arXiv 2608.26218, which it was attributed to. And Gemini CLI is not
  retired: only its consumer tier moved to Antigravity CLI. Neither changes the backlog.

A pleasing loop worth knowing: commit `a8d255d` taught OmniHarness to read `AGENTS.md`, so when
the harness is pointed at this repository it now reads the same instructions you just did.

---

## What is on this branch

Ten commits, oldest first. Every one has tests that were confirmed to fail against the unfixed
version by actually reverting the fix.

| commit | what it does |
|---|---|
| `a8d255d` | **Three fixes.** `edit_file` refuses a non-unique `old_text` (it was silently editing the first match and reporting success). Volatile prompt segments moved last in both agents so the cacheable prefix survives. `internal/instructions` reads `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`. |
| `855d4fc` | **`internal/diagnose` + `omniharness diagnose <session>`.** Four deterministic rules over the recorded trajectory. |
| `04c6296` `8112499` `761fff6` | This handoff: created, a finding recorded mid-investigation, moved to the repo root. |
| `eabc459` | **History eviction kept the wrong end** — it kept the oldest turns and dropped the newest. Now keeps the tail, without orphaning tool results. |
| `2a22b42` | **Context reduces in tiers** — elide tool-result bodies → drop turns → trim prompt — and reports which rung fired. |
| `c537f2d` | **`internal/hook`** — deny-only guards on the tool path, ahead of policy. |
| `34e79b1` | **`policy.EvaluateBatch`** — decide a whole turn, ask once. |
| `70405d9` | **`agent.planTurn`** — wires the above in; a four-write turn now interrupts a person once, not four times. |

### Design decisions you should not quietly undo

- **Hooks can refuse and nothing else.** There is deliberately no permissive verdict. If a hook
  could sanction an action it becomes a route around the policy engine and the approval gate, and
  the first one anyone writes is the hook that approves everything. Policy runs regardless of what
  hooks say. Adding an allow verdict would not extend this design, it would end it. Two tests hold
  the line, including one that puts a permissive hook in front of a blocking policy.
- **Batching is presentation, never semantics.** Every request keeps its own verdict; denying one
  does not deny the rest; blocks never reach a person; a short or failing answer denies everything
  rather than reading as a partial yes.
- **Absent ≠ zero.** `cached_tokens` stays absent when a provider is silent. `AGENTS.md` requires
  this generally; do not add a `?? 0` on the way to a view.
- **Hooks and validation run exactly once per call.** That is the whole reason `planTurn` and
  `executeToolCall` are split rather than policy simply being called twice.

---

## Backlog

Ranked in the research report §09; the numbering is the report's.

- [x] **01** `edit_file` unique match — `a8d255d`
- [x] **02** Prompt reorder + cache accounting — `a8d255d` *(partial: see Open questions)*
- [x] **03** Trajectory diagnostics — `855d4fc`
- [x] **04** Read `AGENTS.md` — `a8d255d`
- [x] **05** Tier the context strategy — `2a22b42` *(history-eviction bug fixed first in `eabc459`)*
- [x] **06** Hooks on the event spine — `c537f2d`
- [x] **07** Approval volume — `34e79b1` + `70405d9` *(batching done; two pieces left, below)*
- [~] **08** Close the sandbox gap, or document the trust model — **trust model documented**
  in `SECURITY.md`, and the live hole found on the way is **fixed** (see *08 — evaluators* below).
  The `.git` write gap is **closed** too. Open: real OS confinement, not started.
- [ ] **09** Learned router behind capability intent

### 07 — the two pieces not done

Batching is in. Still outstanding, both smaller than what shipped:

1. **Grant expiry within a run.** There is still no notion of a grant that ages. A `yes` at step 3
   covers nothing later (each turn is asked fresh), which is safe, but there is also no "allow for
   this session" that would cut volume further without becoming a blanket grant. If you add one,
   it must expire — an unexpiring grant recreates the problem this work set out to fix.
2. **Structured evidence at the prompt.** `Request.Input` reaches the approver but nothing renders
   a diff, a path list, or a size. The batch prompt is the right place for it now that there is one
   prompt per turn to put it in.

### 08 — evaluators ran model-written scripts with the shell off (FIXED)

**Was:** `SECURITY.md` guarantees "`shell_allowed = false` means no shell, including by way of
another tool". But `internal/evaluate` ran `npm test`/`build`/`lint`, `go test`, `cargo build`/`test`
and `pytest` after every software task with no policy check. `write_file` is allowed by default,
so a model-written `package.json` script ran through `sh -c` with nobody asked. `diff-check`'s
`git status` did the same through a planted `core.fsmonitor` in `.git/config`. Both were
reproduced end to end.

**Fix (the user chose option A):** evaluators that execute workspace-defined code implement
`evaluate.RunsWorkspaceCode`. `Registry.AllowWorkspaceCode` (default **false**, fail-closed) is set
from `policy.shell_allowed` in `runtime.go`; when false, `ForTask` swaps those checks for a stub
that keeps the name and reports `NEEDS_REVIEW` ("not run: …"). Never `PASS`: a check that did not
run must not read as one that did. `go build` and `go vet` still run; they compile and analyse
but never execute workspace code.

**Cost the user accepted:** at default config, software tasks are no longer verified by the
repo's own tests. The run records that honestly instead.

**Tests**, all three watched to fail with the fix reverted or the markers removed:
`internal/cli/evaluate_shell_test.go` (real `run`, shell off → script not run; shell on → it
runs, which proves the first test isn't vacuous) and `internal/evaluate/shell_test.go` (an
allowlist of what still runs with the shell off, plus a planted-fsmonitor test that also checks
the plant fires when allowed).

### 08 — still open

1. ~~**An approved `git` call can run commands planted in `.git/config`**~~ **FIXED.**
   `write_file`/`edit_file` call `refuseGitDir` after workspace confinement: any `.git` component
   below the workspace root is refused, lexically and after symlink resolution, in every spelling
   (`isGitDirName`: case, trailing `. `, `:stream`, `GIT~1`, HFS+ zero-width chars). Reading stays
   allowed. Only components *inside* the root are judged, so a workspace under some `.git` dir
   still works. Tests in `internal/tools/gitdir_test.go`, all watched to fail with the guard
   disabled. With it off, the end-to-end test shows the git tool running the planted command.
   Checked and ruled out: the root itself posing as a bare repo (`HEAD`, `objects/`, `refs/`,
   `config` written at the root). `git status` refuses without a work tree, and the model cannot
   write the binary objects `git log -p` would need. Belt-and-braces `-c safe.bareRepository=explicit`
   on the harness's own git calls was **not** added because no exploit could be shown.
2. **No OS confinement.** `SECURITY.md` now says so plainly (trusted workspace, run untrusted
   repos in a container). Implementing Landlock/Seatbelt is a separate, larger decision.

### 08 — what it means, concretely

`internal/envguard` scopes this harness's own credentials out of subprocesses and its doc comment
is candid that a subprocess inherits everything else, deliberately, because `gh pr create` needs
its token. That is credential scoping, not isolation: no filesystem or network confinement, and
the policy engine runs in-process.

Codex CLI ships Landlock + seccomp on Linux and Seatbelt on macOS **on by default**, so this is
now below the field's baseline. Two legitimate answers: implement confinement for shell and MCP
subprocesses and move policy evaluation out of process, or write down explicitly in `SECURITY.md`
that OmniHarness assumes a trusted workspace. Silence is the only wrong answer.

**Read `SECURITY.md` before starting**, and note `AGENTS.md`'s rule: a change that legitimately
touches `policy.RiskAction`, budget ceilings or the loopback guard must say so explicitly in the
PR description.

### Deliberately not doing yet

- **Self-improving harness** (HarnessFix reports 6.3–18.4%) — it hill-climbs against a
  trajectory-scored eval. `diagnose` is the beginning of that eval but does not gate anything yet.
  Build the ruler before the thing that optimises against it.
- **Best-of-N sampling** — the verifier half already exists (`internal/evaluate` + `internal/repair`),
  but sampling multiplies cost, and cache directives are not emitted yet, so it would pay full
  price N times.

---

## Standing constraints from the user

- **Never commit with a `Co-Authored-By` footer.** Also strip GitHub's auto-appended
  "Generated with Claude Code" from PR bodies — it is added server-side at creation, so remove it
  with `update_pull_request` *before* merging.
- **Do not open a PR unless asked.**
- Do not bypass policy risk actions, approval requirements, shell restrictions, budget ceilings,
  loopback restrictions, credential masking, or command-execution safeguards.
- Do not expose API keys, tokens, or inherited environment values.
- Do not silently approve what the core requires a user to approve.
- Do not call providers directly from the TUI; do not duplicate orchestration in the frontend.
- **Do not fabricate telemetry.**

### Working practice the user asked for explicitly

> "when working always have a handoff ready and update after EVERY SINGLE UPDATE"
> "update everytime you even make THE SLIGHTEST change in code"

So: this file changes in the **same commit** as the code it describes. When a finding is verified
but not yet fixed, record it immediately with its status — `8112499` is the precedent, written
before a line of the fix existed.

---

## Environment

- **Network egress is locked down.** `WebFetch` and `curl` both fail with
  `CONNECT tunnel failed, response 403` for arbitrary domains. `WebSearch` works (server-side).
  The research behind the backlog is therefore built from search summaries, not full-text reads.
- **No `gh` CLI.** Use the GitHub MCP tools (`mcp__github__*`).
- **Publishing is automatic and immediate.** Any push to `main` triggers
  `.github/workflows/publish.yml`, which bumps from the **latest published npm version** (not local
  `package.json`) and publishes via OIDC trusted publishing — no token exists anywhere. npm
  propagation lags several minutes, so confirm from the **job log**, not the registry.
  Per `AGENTS.md`: merging to `main` publishes a release; only docs, `.github/` and `_test.go`
  changes are excluded. Nothing here is low-stakes because it looks small.
- **The permission classifier blocks `git rebase` and some `git config` writes** as destructive.
  Ask the user rather than routing around it.
- `git checkout <file>` reverts uncommitted work — back up before deliberate-break testing.

---

## Lessons already paid for

1. **A test that passes for the wrong reason.** The first npm prompt-ordering test asserted where
   the skill list sat relative to memory — but a temp workspace has no custom skills, so the line
   never rendered and the assertion passed vacuously. It now writes an `OMNIHARNESS.md` and asserts
   the line is *present* before asserting where it is. This is `AGENTS.md`'s central rule, learned
   again the hard way: **revert the fix and watch the test fail, every time.**
2. **A deliberate break that does not compile proves nothing.** One attempt produced invalid Go and
   silently "passed". If the break does not build, the verification did not happen.
3. **`TaskCompleted` has its own payload type**, not `TaskStateData`. Matching the wrong one made a
   `diagnose` rule silently match nothing.
4. **A diagnostic that fires on every clean run is noise.** `unverified_completion` initially fired
   on every read-and-answer task. It now requires a non-read tool call to have completed first.
5. **The fake gateway repeats its last step forever**, and the task analyzer consumes steps before
   the agent sees any. A looping run hits the turn cap and errors, so `--json` emits nothing — find
   the session by listing, not by parsing a result.
6. **`''.replace()` matches at position zero.** Redacting against an unset API key prefixed every
   error in the product with `[REDACTED]`. Fixed in `628f5cd` (already on `main`).

---

## Verification tools

- **Go end to end:** `go test ./internal/cli/` drives the real runtime against a fake gateway.
  `internal/cli/diagnose_test.go` is the pattern for a full run → inspect trajectory test.
- **TUI:** `npm/test/harness/tui.tsx` mounts the real interface against a fake terminal;
  `mount({ columns })` gives screen, keyboard and event emitter.
- **PTY render harness:** was at `scratchpad/look.py` — **session-local, now gone.** If you need to
  render the TUI at several widths, rebuild it or use the `tui.tsx` harness. `AGENTS.md` requires
  actually rendering any change under `npm/src/tui/`.

---

## Open questions for the user

1. **Cache directives are not emitted.** The prompt is now *shaped* for caching (volatile content
   last) and reported hit rate is *recorded*, but nothing sends `cache_control`. Whether OmniRoute
   passes Anthropic-style cache breakpoints through its OpenAI-compatible surface is unverified and
   cannot be checked without a live gateway. This is the unfinished half of backlog item 02.
2. **Commit authorship.** Commits from `34e79b1` onward are authored
   `Ship King <227889443+shipking-ai@users.noreply.github.com>`. The **eight before it**
   (`a8d255d` … `c537f2d`) are still `Claude <noreply@anthropic.com>`, so that work does not appear
   on the owner's contribution graph. Re-authoring them is a rebase, which the permission classifier
   blocks; the user approved it verbally but the block held. Needs a Bash permission rule for
   `git rebase`. **Merged commits must not be rewritten either way.**
3. **No PR is open** for these ten commits.
