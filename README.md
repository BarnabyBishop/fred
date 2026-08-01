# Fred

A pnpm monorepo.

| Package | Path | What it is |
|---------|------|------------|
| `nanoclaw` | [`fred/`](fred/) | The assistant host — a fork of NanoClaw. See [`fred/README.md`](fred/README.md). |
| `gazoo` | [`gazoo/`](gazoo/) | Web UI that consumes Fred. Placeholder for now. |

## Getting started

```bash
pnpm install            # installs both workspace packages
pnpm --filter nanoclaw run dev
```

Package-level commands run through pnpm filters:

```bash
pnpm --filter nanoclaw run <script>
pnpm --filter gazoo run <script>
pnpm -r run build       # every package
```

The agent container tree (`fred/container/agent-runner/`) is deliberately **not**
a workspace member — it runs on Bun with its own `bun.lock`. See
[`fred/docs/build-and-runtime.md`](fred/docs/build-and-runtime.md).
