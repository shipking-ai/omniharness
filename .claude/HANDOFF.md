# Handoff

Live state of the agent-harness improvement work. **Updated after every change.**
If you are picking this up cold, read this file top to bottom and you have everything.

- **Branch:** `claude/inspiring-hypatia-wx35s3`
- **Base:** `main` (fast-forwarded to `cca9b4b` after PR #126 merged)
- **Published:** `omniharness-cli@0.1.122` (auto-published on merge to `main`)
- **Last updated:** in progress on **05**, see In flight

---

## Where things stand

| | |
|---|---|
| Commits on branch, unmerged | `a8d255d`, `855d4fc` |
| Open PR | none — not opened yet, user has not asked |
| Go tests | 630 test functions, `go test ./...` clean |
| npm tests | 463 pass |
| `gofmt` / `go vet` / `typecheck` | clean |

### Unmerged commits

- **`a8d255d`** — `fix(harness): refuse ambiguous edits, stop breaking the prompt cache, read AGENTS.md`
  - `edit_file` refuses a non-unique `old_text` (was silently editing the first match and reporting success)
  - Volatile prompt segments moved last in both agents (Go `SUMMARY OF PRIOR WORK`, npm `PERSISTENT MEMORY`) so the cacheable prefix survives
  - `prompt_tokens_details.cached_tokens` read and carried through both clients
  - New `internal/instructions` reads `AGENTS.md` → `CLAUDE.md` → `GEMINI.md`
- **`855d4fc`** — `feat(diagnose): read the trajectory, not just the outcome`
  - New `internal/diagnose` + `omniharness diagnose <session>` with `--json` / `--strict`
  - Four deterministic rules: `repeated_call`, `tool_thrash`, `unverified_completion`, `unapproved_risk`

---

## Backlog

Ranked in the research report (§09). Numbering is the report's.

- [x] **01** Fix `edit_file` to require a unique match — *done in `a8d255d`*
- [x] **02** Reorder the prompt, then cache it — *done in `a8d255d`* (reordering + `cached_tokens` accounting; **emitting** cache directives is NOT done, see Open questions)
- [x] **03** Read the trajectories you already record — *done in `855d4fc`*
- [x] **04** Read AGENTS.md — *done in `a8d255d`*
- [ ] **05** Tier the context strategy — **NEXT**
- [ ] **06** Add hooks on top of the event spine
- [ ] **07** Design for approval volume, not just classification
- [ ] **08** Close the sandbox gap, or document the trust model
- [ ] **09** Put a learned router behind capability intent

### IN FLIGHT — history eviction keeps the wrong end

Found while starting 05, verified empirically rather than by reading. In
`internal/context/context.go` the history loop appends oldest-first until the
budget runs out and then breaks, so **it keeps the oldest turns and drops the
newest**. With four turns and room for two, `OLDEST-turn` and `middle-one`
survive; `middle-two` and `NEWEST-turn` are dropped.

That is close to the worst possible eviction order: the agent loses the tool
results it just received — the thing it needs to continue — and keeps the
opening exchange it has already acted on. It also explains why a long run
degrades rather than merely shortening.

This is bigger than the tiering and goes first. 05 as written still stands,
but the ladder is worth less than fixing which end survives.

**Status:** verified, not yet fixed. Nothing changed on disk yet.

### 05 — what it means, concretely

`internal/context/context.go` condenses at one `CondenseAt` threshold. Replace with an
ordered ladder: **evict tool results → condense history → summarise → refuse**, emitting a
distinct event per tier so the TUI can say which fired and `diagnose` can measure whether
it helped. Evidence: context editing is worth 29–39% on the published numbers.

### Deliberately NOT doing yet

- **Self-improving harness** (HarnessFix, 6.3–18.4%) — it hill-climbs against a
  trajectory-scored eval. `diagnose` is the start of that eval; it needs to be gating
  before this is worth attempting.
- **Best-of-N sampling** — the verifier half exists (`internal/evaluate`), but sampling
  multiplies cost. Do it after cache directives land, or pay full price N times.

---

## Standing constraints (from the user, still in force)

- **Never commit with a Co-Authored-By footer.** Strip GitHub's auto-appended
  "Generated with Claude Code" from PR bodies too — it is added server-side at creation,
  remove it with `update_pull_request` before merging.
- Do not open a PR unless asked.
- Do not bypass: policy risk actions, approval requirements, shell restrictions, budget
  ceilings, loopback restrictions, credential masking, command execution safeguards.
- Do not expose API keys, tokens or inherited environment values.
- Do not silently approve what the core requires a user to approve.
- Do not call providers directly from the TUI; do not duplicate orchestration in the
  frontend.
- **Do not fabricate telemetry.** Absent ≠ zero — this is why `cached_tokens` stays
  absent when a provider is silent rather than collapsing to 0.

## Working practices established here

- Every fix gets a test that **fails when the fix is reverted**, verified by actually
  reverting it. This caught a vacuous test once already (see Lessons).
- Verify in the real application, not just tests — PTY harness at
  `scratchpad/look.py` renders the npm TUI; `go test ./internal/cli/` drives the Go
  runtime end to end.
- Run `gofmt -l ./cmd ./internal && go vet ./... && go test ./...` and
  `cd npm && npm run typecheck && npm test` before every commit.

---

## Environment gotchas

- **Network egress is locked down.** `WebFetch` and `curl` both fail with
  `CONNECT tunnel failed, response 403` for arbitrary domains. `WebSearch` works
  (server-side). Research is therefore built from search summaries, not full-text reads.
- **No `gh` CLI.** Use the GitHub MCP tools (`mcp__github__*`) for everything.
- **Publishing is automatic.** Any push to `main` triggers `.github/workflows/publish.yml`,
  which bumps from the **latest published npm version** (not local `package.json`) and
  publishes via OIDC trusted publishing. No token exists anywhere. npm propagation lags
  several minutes — read the **job log**, not the registry, to confirm.
- `git checkout <file>` reverts uncommitted work. Back up before deliberate-break tests
  (bitten once, see Lessons).

---

## Lessons paid for already

1. **A test that passes for the wrong reason.** The first npm prompt-ordering test asserted
   where the skill list sat relative to memory — but a temp workspace has no custom skills,
   so the line never rendered and the assertion passed vacuously. It now writes an
   `OMNIHARNESS.md` and asserts the line is *present* before asserting where it is.
   **Always confirm a new test fails when the fix is reverted.**
2. **`TaskCompleted` has its own payload type**, not `TaskStateData`. Matching on the
   wrong one made the completion rule silently match nothing.
3. **The fake gateway repeats its last step forever**, and the task analyzer consumes
   steps before the agent sees any. A looping run hits the turn cap and errors, so
   `--json` emits nothing — find the session by listing, not by parsing a result.
4. **`''.replace()` matches at position zero.** Redacting against an unset API key
   prefixed every error in the product with `[REDACTED]`. Fixed in `628f5cd`.

---

## Reference

- **Research report** (3 editions, the source of the backlog):
  https://claude.ai/artifact/5gge1j8cfVov9RXCcodZzK
- **Architecture:** `docs/architecture.md` — the design of record, still accurate
- **Scratchpad:** `/tmp/claude-0/-home-user-omniharness/9840077e-7d01-59da-83a6-92a9342cf8a9/scratchpad/`
  (`look.py` is the PTY render harness; session-local, does not survive)

## Open questions for the user

- **Cache directives are not emitted.** The prompt is now *shaped* for caching and the
  reported hit rate is *recorded*, but nothing sends `cache_control`. Whether OmniRoute
  passes Anthropic-style cache breakpoints through its OpenAI-compatible surface is
  unverified and cannot be checked without a live gateway.
- **PR not opened** for `a8d255d` + `855d4fc`.
