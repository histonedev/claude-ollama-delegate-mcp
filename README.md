# ollama-mcp

Delegate tasks from an Anthropic-backed Claude Code session to **Ollama-backed**
Claude Code sessions — without the two ever sharing environment variables.

`ollama launch claude --model <model>` works by exporting `ANTHROPIC_*` variables
into your shell. That is why it normally needs its own terminal: the variables
are process-wide, so one shell is either "Anthropic" or "Ollama", never both.

This MCP server spawns each delegated session as a child process with an
**explicitly constructed environment**. Your Opus session keeps its own
credentials and model settings; the delegate gets Ollama's. They run side by side
in the same terminal.

```
┌────────────────────────────┐
│  Claude Code (Opus)        │   your session, Anthropic credentials
│                            │
│   └─ mcp: ollama-mcp ──────┼──▶ spawn: claude -p   (fresh env)
└────────────────────────────┘         ANTHROPIC_BASE_URL=127.0.0.1:11434
                                       ANTHROPIC_AUTH_TOKEN=ollama
                                       → qwen3.5:397b-cloud
```

---

## Contents

- [How it works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Delegation modes](#delegation-modes)
- [Tool reference](#tool-reference)
- [Operating it](#operating-it)
- [Job artifacts](#job-artifacts)
- [Troubleshooting](#troubleshooting)
- [Platform support](#platform-support)
- [Security model](#security-model)
- [Development](#development)

---

## How it works

Ollama's server exposes an Anthropic-compatible `POST /v1/messages` endpoint, so
Claude Code can talk to it unmodified if pointed at the right base URL. Each
delegated task runs as `claude -p` in its own process with:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:11434
ANTHROPIC_AUTH_TOKEN=ollama
ANTHROPIC_DEFAULT_OPUS_MODEL=<model>
ANTHROPIC_DEFAULT_SONNET_MODEL=<model>
ANTHROPIC_DEFAULT_HAIKU_MODEL=<model>
CLAUDE_CODE_SUBAGENT_MODEL=<model>
```

All three model slots point at the same Ollama model so that aliases (`opus`,
`sonnet`, `haiku`) and any subagent spawned *inside* the delegate resolve to it,
rather than silently falling back to an Anthropic default.

The child environment is built from a small per-platform allowlist. Anything
matching `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `GOOGLE_*`, `AZURE_*`, `OPENAI_*`,
`BEDROCK_*`, `VERTEX_*` is dropped **before** the Ollama values are applied, so a
stray `ANTHROPIC_API_KEY` in your shell cannot leak into — or bill — a delegated
run.

Delegates also start with `--strict-mcp-config` and no MCP config, which keeps
their startup fast and stops them from recursively calling this server.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js 20+** | `node --version`. Built and tested on 24. |
| **Ollama** | [ollama.com/download](https://ollama.com/download). Must be running: `ollama serve` (the desktop app does this for you). |
| **Claude Code CLI** | [claude.com/code](https://claude.com/code). `claude --version`. |
| **At least one model** | `ollama pull qwen3.5:397b-cloud` |
| **An Ollama account** | Only for `:cloud` models — `ollama signin`. Local models need no account. |

Verify the pieces before installing:

```bash
node --version                              # v20 or newer
claude --version
curl -s http://127.0.0.1:11434/api/version  # {"version":"..."}
ollama list                                 # at least one model
```

> **Cloud vs local models.** Models tagged `:cloud` run on Ollama's
> infrastructure and require `ollama signin`; they are far more capable than what
> most laptops fit in memory, which makes them the practical choice for
> delegation. Local models work too and never leave your machine.

---

## Installation

### From npm (recommended)

No clone or build required — `npx` fetches it on demand:

```bash
claude mcp add ollama --scope user -- npx -y claude-ollama-delegate-mcp
```

Or install it globally, which also puts the settings CLI on your `PATH`:

```bash
npm install -g claude-ollama-delegate-mcp
claude mcp add ollama --scope user -- claude-ollama-delegate-mcp
```

### From source

```bash
git clone https://github.com/histonedev/claude-ollama-delegate-mcp.git
cd claude-ollama-delegate-mcp
npm install          # builds automatically via the prepare script
claude mcp add ollama --scope user -- node "$(pwd)/dist/index.js"
```

Run the settings CLI as `node dist/cli.js …`, or `npm link` to get
`ollama-mcp-config` on your `PATH`.

### Scopes

`--scope user` makes it available in every project; `--scope project` writes to
`.mcp.json` in the current repo and shares it with collaborators; `--scope local`
keeps it to this machine and project.

### Confirm

```bash
claude mcp list        # ollama: ... - ✔ Connected
```

Then **restart your Claude Code session** — the tool list is read at startup.

## Configuration

Settings resolve from four layers, later winning over earlier:

1. built-in defaults
2. user config — `~/.ollama-mcp/config.json` (override the path with `$OLLAMA_MCP_CONFIG`)
3. project config — `./ollama-mcp.config.json` in the server's working directory
4. environment variables

```json
{
  "delegationMode": "ondemand",
  "allowedModels": ["qwen3.5:397b-cloud", "gemma4:31b-cloud"],
  "defaultModel": "qwen3.5:397b-cloud",
  "defaultPermissionMode": "auto",
  "baseUrl": "http://127.0.0.1:11434",
  "claudeBin": "claude",
  "stateDir": "~/.ollama-mcp/jobs",
  "jobTimeoutMs": 1800000,
  "maxInlineChars": 60000
}
```

| Setting | Env var | Default | Meaning |
| --- | --- | --- | --- |
| `delegationMode` | `OLLAMA_MCP_DELEGATION_MODE` | `ondemand` | How eagerly delegation is used — see below |
| `allowedModels` | `OLLAMA_MCP_ALLOWED_MODELS` (comma-separated) | `[]` (all) | Models delegation may use |
| `defaultModel` | `OLLAMA_MCP_DEFAULT_MODEL` | first allowed cloud model | Model when a call omits one |
| `defaultPermissionMode` | `OLLAMA_MCP_PERMISSION_MODE` | `auto` | Permission mode for delegates |
| `baseUrl` | `OLLAMA_MCP_BASE_URL` or `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama endpoint |
| `claudeBin` | `OLLAMA_MCP_CLAUDE_BIN` | `claude` | Path to the Claude Code CLI |
| `stateDir` | `OLLAMA_MCP_STATE_DIR` | `~/.ollama-mcp/jobs` | Prompts, transcripts, results |
| `jobTimeoutMs` | `OLLAMA_MCP_JOB_TIMEOUT_MS` | `1800000` | Hard kill for one turn |
| `maxInlineChars` | `OLLAMA_MCP_MAX_INLINE_CHARS` | `60000` | Output above this is truncated; full text on disk |

### Changing settings

Settings are changed from a terminal, never by the model:

```bash
ollama-mcp-config                              # show current settings + active layers
ollama-mcp-config --mode auto                  # off | ondemand | auto
ollama-mcp-config --allow qwen3.5:397b-cloud   # or: --allow all
ollama-mcp-config --default-model qwen3.5:397b-cloud
ollama-mcp-config --permission-mode acceptEdits
ollama-mcp-config --scope project              # write ./ollama-mcp.config.json
```

Then **restart your Claude Code session** so the server re-reads its config.

**There is deliberately no MCP tool for this.** See [Security model](#security-model).

### Allowed models

`allowedModels: []` (the default) permits any model the server offers. With a
non-empty list:

- `delegate_start` rejects a model outside it, naming the allowed set rather than
  silently substituting one
- `ollama_models` marks excluded models `BLOCKED by allowedModels`
- the allowed list is embedded in the `delegate_start` tool description, so the
  orchestrator knows the menu without an extra call
- the CLI refuses a change that would strand `defaultModel` outside the new list

---

## Delegation modes

This controls **how eagerly the orchestrator reaches for delegation**, by
rewriting the tool descriptions the model actually reads. Changing it requires a
session restart, by design.

| Mode | Effect |
| --- | --- |
| `off` | The `delegate_*` tools are hidden entirely. `ollama_models` remains so the model can still report the setup. |
| `ondemand` *(default)* | Delegate **only when you explicitly ask** — "delegate this", "use ollama", "ask qwen". Otherwise the orchestrator does the work itself and does not mention the tools. |
| `auto` | The orchestrator **decides for itself**, using criteria baked into the description. |

In `auto` mode the description tells the orchestrator to delegate work that is
self-contained, cheaply verifiable and context-hungry — bulk file summarisation,
first-pass searches, mechanical refactors, boilerplate and test scaffolding, log
or diff triage — while keeping architecture decisions, security-sensitive
changes, ambiguous requirements and final review for itself. It is also told to
verify delegated claims, for the reason in [Operating it](#trusting-delegated-output).

---

## Tool reference

| Tool | Purpose |
| --- | --- |
| `ollama_models` | List servable models and report current settings (read-only) |
| `delegate_start` | Start a task; returns a `job_id` immediately |
| `delegate_followup` | Send another message to the same session |
| `delegate_status` | Poll state plus a tail of the delegate's tool calls |
| `delegate_result` | Collect final output |
| `delegate_cancel` | Terminate a running delegate and everything it started |
| `delegate_list` | List jobs, grouped by conversation |

### `delegate_start`

| Parameter | Type | Notes |
| --- | --- | --- |
| `prompt` | string | The task. Mutually exclusive with `prompt_file`. |
| `prompt_file` | string | Path to a file holding the prompt. Preferred when long. |
| `model` | string | Must be in the allowed list. Defaults to `defaultModel`. |
| `cwd` | string | Working directory for the delegate. Defaults to the server's cwd. |
| `permission_mode` | enum | `auto`, `acceptEdits`, `bypassPermissions`, `manual`, `dontAsk`, `plan` |
| `allowed_tools` | string[] | e.g. `["Read","Grep","Bash(git *)"]` |
| `disallowed_tools` | string[] | e.g. `["Write","Edit"]` |
| `append_system_prompt` | string | Extra instructions for the delegate |
| `max_turns` | number | Cap the delegate's agentic turns |
| `add_dirs` | string[] | Additional accessible directories |
| `wait_seconds` | number | Block up to N seconds (0–600). Default 0 = return immediately. |

`delegate_followup` takes `job_id` **or** `session_id`, plus the same
prompt/`prompt_file` pair and optional `permission_mode`, `max_turns`,
`wait_seconds`.

---

## Operating it

### Asynchronous by default

`delegate_start` returns a `job_id` in milliseconds; the delegate keeps running
in the background. This keeps a long task from stalling your session or tripping
an MCP client timeout.

```
delegate_start({ prompt: "Audit src/ for unused exports" })
  → job_id A, session_id S, turn 1, state: running

delegate_status({ job_id: "A" })
  → recent activity:
      [tool] Grep: export
      [tool] Read: /repo/src/index.ts

delegate_result({ job_id: "A" })
  → the final text
```

Pass `wait_seconds` on any of those to block instead — useful for short tasks
where a round trip of polling is not worth it.

### Two-way conversations

Every job carries a `session_id`. Passing its `job_id` to `delegate_followup`
resumes the session with full history; the `session_id` stays stable across turns
while each turn gets a fresh `job_id`.

```
delegate_start({ prompt: "Summarise the auth flow in this repo" })
  → job A, session S, turn 1
delegate_followup({ job_id: "A", prompt: "Now list every place it can fail" })
  → job B, session S, turn 2   (delegate still remembers turn 1)
```

Following up is much cheaper than starting fresh when the delegate already has
the relevant context loaded.

### Long prompts

Every prompt parameter has a `prompt_file` counterpart. Internally the prompt is
always written to disk and fed to the CLI over **stdin** — never as an argv entry
and never through a shell. Backticks, `$(...)`, quotes, newlines and glob
characters pass through verbatim, and there is no argv length limit.

```
delegate_start({ prompt_file: "/tmp/refactor-brief.md" })
```

### Permissions

Delegates default to `defaultPermissionMode` (`auto`). Narrow a specific call:

```
// read-only review
delegate_start({ prompt: "...", disallowed_tools: ["Write", "Edit", "NotebookEdit"] })

// tightly scoped
delegate_start({ prompt: "...", allowed_tools: ["Read", "Grep", "Glob"] })
```

### Trusting delegated output

Every finished result reports its **tool-call count**. Weaker models sometimes
answer confidently without running anything — during development, one model
claimed an environment variable was unset without ever invoking Bash; when
pushed, it ran the command and reported the correct value.

A result carrying `tool calls: 0` is therefore annotated as unverified:

```
tool calls: 0   <- answered without using any tools; treat factual claims as unverified
```

`delegate_status` shows the actual trace. A purely conversational follow-up
legitimately has zero — the flag means "nothing backs this", not "something broke".

### Cancelling

```
delegate_cancel({ job_id: "A" })
```

Kills the delegate **and everything it started**, so a delegate that was midway
through a long build does not leave the build running.

---

## Job artifacts

Each job writes to `~/.ollama-mcp/jobs/<job_id>/`:

| File | Contents |
| --- | --- |
| `prompt.txt` | Exactly what was sent |
| `stream.jsonl` | Full `stream-json` transcript, including every tool call |
| `result.json` | Metadata: state, model, tokens, timings, exit code |
| `result.txt` | Final output text |

Results longer than `maxInlineChars` are truncated in the tool response and the
full text read from `result.txt`. Nothing is pruned automatically — delete the
directory whenever you like.

---

## Troubleshooting

**`Cannot reach Ollama at http://127.0.0.1:11434`**
Ollama is not running. Start `ollama serve` or open the desktop app. If it listens
elsewhere, set `OLLAMA_MCP_BASE_URL`.

**`No models available from Ollama`**
`ollama pull qwen3.5:397b-cloud`, and `ollama signin` for `:cloud` models.

**`<model> was retired at …` (HTTP 410)**
Ollama removed that cloud model. `ollama list` still shows locally cached
manifests for retired models — check what actually works and update
`defaultModel`.

**`Model "x" is not in the allowed list`**
Working as intended. `ollama-mcp-config --allow <models>`, then restart.

**Tools do not appear in Claude Code**
The tool list is read at session start. Restart, or check `claude mcp list`.

**Delegate fails instantly with a launch error**
The CLI was not found. Set `OLLAMA_MCP_CLAUDE_BIN` to the absolute path of
`claude`.

**Everything is slow**
Cloud models pay a round trip per turn, and Claude Code sends a large system
prompt (~25k tokens) on every request. Use `max_turns` to cap agentic loops and
`allowed_tools` to stop the delegate exploring more than it needs to.

---

## Platform support

| Platform | Status |
| --- | --- |
| macOS | Tested end to end |
| Linux | Supported; same POSIX code path as macOS |
| Windows | Supported by design, **not yet tested on real hardware** |

Platform differences are isolated in `src/platform.ts`:

**Binary resolution.** On POSIX, `spawn` searches `PATH`. On Windows a native
install gives `claude.exe` while an npm install gives `claude.cmd`, which
`CreateProcess` cannot execute directly — so the server walks `PATH` × `PATHEXT`
preferring `.exe`, and falls back to routing a `.cmd` shim through `cmd.exe`.

**Argument escaping.** That fallback applies two layers: MSVCRT argv quoting, then
a caret escape of cmd's own metacharacters (`& | < > ^ " ( ) % !`). Skipping the
second layer is the classic `.cmd` command-injection hole. Prompts never touch
this path — they travel over stdin. One limitation: a *multi-line*
`append_system_prompt` cannot cross a `cmd.exe` command line, so the server raises
a clear error pointing at `OLLAMA_MCP_CLAUDE_BIN` instead of silently mangling it.

**Environment allowlist.** Windows preserves a much larger set than POSIX.
`SystemRoot` and `windir` are not optional — strip them and Winsock fails to
initialise, so the child cannot open a socket even to localhost. Names are matched
case-insensitively but copied with the parent's original spelling.

**Cancellation.** POSIX children are spawned `detached` as process-group leaders
and cancelled with `process.kill(-pid)`; Windows uses `taskkill /T /F`. Either way
the delegate's own subprocesses die with it. The server also kills running
delegates when it shuts down.

---

## Security model

**Credential isolation is the point.** The child environment is constructed from
scratch rather than inherited, and provider variables are stripped before the
Ollama values are applied. This is covered by `test/env-unit.mjs`, and
`test/e2e.mjs` poisons the parent with a fake `ANTHROPIC_API_KEY` and asserts it
never reaches the delegate.

**Delegation policy is not model-writable.** There is no MCP tool to change
`delegationMode` or `allowedModels`. An earlier version had one, which was a
mistake: a model that finds `ondemand` inconvenient could flip itself to `auto`
in a single call and then delegate freely. Settings now load once at startup, are
never mutated at runtime, and the tool descriptions state that the policy is not
the model's to change.

**This is a guardrail, not a security boundary.** An agent with shell access can
still edit the config file. What removing the tool buys you is that such a change
is a *visible file edit that only takes effect on the next restart*, rather than a
single silent tool call mid-task. To make it airtight, pin the values via `--env`
on the MCP registration, which overrides the config files:

```bash
claude mcp add ollama --scope user \
  --env OLLAMA_MCP_DELEGATION_MODE=ondemand \
  --env OLLAMA_MCP_ALLOWED_MODELS=qwen3.5:397b-cloud \
  -- node /path/to/claude-ollama-delegate-mcp/dist/index.js
```

**Delegates inherit your filesystem.** They run as your user in the `cwd` you
give them, with `defaultPermissionMode`. Treat a delegated session as you would
any Claude Code session — use `disallowed_tools` or a read-only permission mode
when handing work to a model you trust less.

---

## Development

```bash
npm install        # installs and builds
npm run build      # tsc
npm run dev        # tsc --watch
```

### Tests

```bash
node test/env-unit.mjs       # env isolation: no secret leaks, platform vars present
node test/quoting.mjs        # Windows argv/cmd escaping, incl. an injection probe
node test/killtree-unit.mjs  # process-tree termination
node test/e2e.mjs            # full MCP round trip           (needs Ollama running)
node test/async.mjs          # async polling, prompt_file, cancel  (needs Ollama)
CFG_PATH=/tmp/c.json CFG_CWD=/tmp node test/readonly.mjs   # config is read-only to the model
```

`npm test` runs the three that need no network.

### Publishing a release

```bash
npm login                       # interactive, once per machine
npm version patch               # or minor / major -- tags and bumps
npm publish                     # prepare script builds first
git push --follow-tags
```

Run `npm publish` from a **real terminal**, not a script or a non-interactive
shell. With WebAuthn/security-key 2FA the CLI completes the challenge by opening
a browser; without a TTY it cannot, and falls back to demanding a TOTP code that
a security key cannot produce (`npm error code EOTP`). For CI, use a granular
access token with Bypass 2FA instead.

The package is `claude-ollama-delegate-mcp` and ships only `dist/`, `README.md`
and `LICENSE`. `publishConfig.access` is `public`, and `prepare` runs `tsc`
before packing, so a stale `dist/` can never be published. Preview the tarball
with `npm pack --dry-run` before shipping.

### Layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | MCP server, tool registration and handlers |
| `src/settings.ts` | Layered config loading and validation |
| `src/config.ts` | Startup-resolved settings singleton |
| `src/descriptions.ts` | Mode-dependent tool descriptions |
| `src/env.ts` | Child-environment construction and the provider-variable blocklist |
| `src/platform.ts` | Windows/POSIX spawn, argument escaping, process-tree kill |
| `src/jobs.ts` | Job lifecycle, `stream-json` parsing, cancellation |
| `src/models.ts` | Model discovery and allowlist enforcement |
| `src/cli.ts` | `ollama-mcp-config` settings CLI |

---

## License

MIT — see [LICENSE](LICENSE).
