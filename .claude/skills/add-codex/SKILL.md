---
name: add-codex
description: Use Codex (OpenAI's codex app-server) as a full agent provider — planning, tool orchestration, MCP tools, server-side history, session resume — alongside or instead of Claude. ChatGPT subscription or OpenAI API key, vault-only via OneCLI. Per-group via `ncl groups config update --provider codex`. Distinct from using OpenAI as an MCP tool (where Claude remains the planner).
---

# Codex agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth codex` performs this whole install (manifest-driven from the providers branch: files, barrels, CLI manifest entry, image rebuild) plus auth in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the Codex provider: copy the payload from the `providers` branch, append one import to each of the three provider barrels, add the pinned Codex CLI to the container manifest (`container/cli-tools.json`), rebuild, then run the vault auth walk-through.

The provider runs `codex app-server` as a child process speaking JSON-RPC over stdio: native streaming, MCP tools, server-side conversation history (the continuation is a thread id). Credentials are **vault-only**: OneCLI serves a sentinel `auth.json` stub into the container and swaps the real ChatGPT token or API key on the wire — no key in `.env`, nothing readable in the container.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Per-group state directory

Codex keeps its own state at `data/v2-sessions/<group-id>/.codex-shared`, mounted RW at `/home/node/.codex`. It **outlives container restarts and image rebuilds** — restarting a group or repinning its image does not touch it. Two files in there grow without bound, and both have bitten us:

- `logs_2.sqlite` — codex's tracing log, written at TRACE/DEBUG including `hyper_util::client::legacy::*` wire tracing (~2.9 KB/row, ~500 MB/day at a quiet baseline). codex opens this database **before** it answers the JSON-RPC `initialize` handshake, so once it is large enough the open blows the 30 s deadline and every spawn dies with `Error: Timeout waiting for initialize response (30000ms)` and a clean `[codex-app-server] [exit] code=0 signal=null`. One group reached 31 GB this way. The host bounds it as a backstop — `src/provider-state-guard.ts` renames an oversized `logs_2.sqlite` aside on a sweep tick (2 GB default, `NANOCLAW_PROVIDER_STATE_MAX_BYTES` in `.env` to change) and logs loudly; the payload should also set `RUST_LOG=warn` in its `ProviderContainerContribution.env` so the volume never builds up.
- `sessions/YYYY/MM/DD/rollout-*.jsonl` — the rollout for each thread. Contrary to what this skill used to claim, codex **does** keep an on-disk transcript: it is re-parsed on every `thread/resume` (`Resumed rollout with N items`), and a long-lived group's rollout has been seen at 20.9 MB / 35k items. That is what `AgentProvider.maybeRotateContinuation` exists for (`container/agent-runner/src/providers/types.ts`); the Claude provider implements it against its `.jsonl` transcript in `providers/claude.ts`. The codex provider should mirror it against the rollout file for the thread id.

Recovery when a group is already wedged: stop the **host service** first (the sweep respawns containers on a 60 s tick), then `mv` the log aside — never `VACUUM`, which needs ~2× the file size free — and clear the stored continuation if the rollout is also huge:

```bash
systemctl --user stop nanoclaw-v2-<slug>.service        # macOS: launchctl unload …
docker stop $(docker ps -q --filter name=nanoclaw-v2-)
CODEX=data/v2-sessions/<group-id>/.codex-shared
mv $CODEX/logs_2.sqlite $CODEX/logs_2.sqlite.bak-$(date +%Y%m%d)
pnpm exec tsx scripts/q.ts data/v2-sessions/<group-id>/<session-id>/outbound.db \
  "DELETE FROM session_state WHERE key='continuation:codex';"
systemctl --user start nanoclaw-v2-<slug>.service
```

Delete the backup and its `-wal`/`-shm` siblings once the group answers again. On a healthy group `/clear` is the better route to the same reset — the runner handles it before the provider is invoked.

## Install

### Pre-flight

Check whether the payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/codex.ts` and `src/providers/codex-agents-md.ts`
- `container/agent-runner/src/providers/codex.ts` and `codex-app-server.ts`
- `setup/providers/codex.ts`
- `import './codex.js';` in `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, and `setup/providers/index.ts`
- an `@openai/codex` entry in `container/cli-tools.json`

### 1. Fetch and copy the payload

Fetch the `providers` branch and copy the Codex payload into all three trees (additive — overwrite each file, never merge the branch). The host files are the provider contribution + AGENTS.md compose + their guards; the container files are the provider runtime (turn loop, JSON-RPC wrapper, native memory SessionStart hook, per-exchange archiver) + their guards; the setup file is the picker entry + vault auth walk-through; `container/AGENTS.md` is the runtime-contract base the composed AGENTS.md embeds.

```nc:copy from-branch:providers
src/providers/codex.ts
src/providers/codex-agents-md.ts
src/providers/codex-registration.test.ts
src/providers/codex-host-contribution.test.ts
src/providers/codex-agents-md.test.ts
container/agent-runner/src/providers/codex.ts
container/agent-runner/src/providers/codex-app-server.ts
container/agent-runner/src/providers/exchange-archive.ts
container/agent-runner/src/providers/exchange-archive.test.ts
container/agent-runner/src/providers/codex-registration.test.ts
container/agent-runner/src/providers/codex.factory.test.ts
container/agent-runner/src/providers/codex.turns.test.ts
container/agent-runner/src/providers/codex-app-server.test.ts
container/agent-runner/src/providers/codex-cli-tools.test.ts
setup/providers/codex.ts
setup/providers/codex.test.ts
setup/providers/codex-registration.test.ts
container/AGENTS.md
```

### 2. Wire the barrels

Append the self-registration import to each of the three provider barrels (skipped if the line is already present). Each barrel-registration test imports its real barrel and asserts `codex` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './codex.js';
```
```nc:append to:container/agent-runner/src/providers/index.ts
import './codex.js';
```
```nc:append to:setup/providers/index.ts
import './codex.js';
```

### 3. CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. Add Codex by appending one entry — idempotent on `name`, so a re-run is a no-op. `@openai/codex` has no native postinstall, so no `onlyBuilt`. The Dockerfile already installs every manifest entry via pinned `pnpm install -g`; no Dockerfile edit is needed.

```nc:json-merge into:container/cli-tools.json key:name
{ "name": "@openai/codex", "version": "0.138.0" }
```

The version (`0.138.0`) is the canonical pin — this SKILL.md is the source of truth.

### 4. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 5. Validate

```nc:run effect:test
pnpm vitest run src/providers/codex-registration.test.ts src/providers/codex-host-contribution.test.ts src/providers/codex-agents-md.test.ts setup/providers/
```
```nc:run effect:test
cd container/agent-runner && bun test src/providers/
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload is broken.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth codex
```

The same walk-through fresh installs get from the setup picker: ChatGPT subscription (browser login or device pairing) or an OpenAI API key, landed in the OneCLI vault. Idempotent — it short-circuits when a matching secret already exists. It finishes with the install check.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider codex
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the
same `memory/` tree, so memory carries across automatically. Run
`/migrate-memory` only when upgrading a group that still has legacy `.seed.md`,
`CLAUDE.local.md`, or unindexed imported memory. See
[docs/provider-migration.md](../../docs/provider-migration.md).

### Default new groups to codex (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires codex in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Codex is installed. Default new agent groups to codex? Existing groups keep their current provider."

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value codex
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

This affects only groups created afterward. Per-group `ncl groups config update --provider` still overrides the default in either direction. Creation itself stays provider-agnostic (no `--provider` flag — provider is a DB property stamped from the instance default at creation).

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (e.g. `Unknown provider: codex. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`.
- **`Timeout waiting for initialize response (30000ms)` on every message, container exits `code=0`:** the group's `.codex-shared/logs_2.sqlite` has grown too large to open — see **Per-group state directory** above. `ls -la data/v2-sessions/*/.codex-shared/logs_2.sqlite` compares groups in one line.
- **Auth errors mid-conversation:** the vault secret is missing or stale — re-run `pnpm exec tsx setup/index.ts --step provider-auth codex` (subscription re-login updates the vault copy).
