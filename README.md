# Fred

A pnpm monorepo.

| Package | Path | What it is |
|---------|------|------------|
| `nanoclaw` | [`fred/`](fred/) | The assistant host — a fork of NanoClaw, vendored whole. See [`fred/README.md`](fred/README.md). |
| `gazoo` | [`gazoo/`](gazoo/) | Web UI that consumes Fred. Placeholder for now. |

Everything inherited from upstream NanoClaw lives under `fred/` — including its
own `.github/`, `.husky/`, `.npmrc`, `.nvmrc`, and `LICENSE`. The root holds only
the workspace itself, and is where our own tooling goes.

> **Note:** because GitHub only reads workflows from the repository root,
> `fred/.github/workflows/` is currently **dormant** — no CI runs on push or PR
> until a root-level workflow exists. Same for `fred/.github/PULL_REQUEST_TEMPLATE.md`.

## Getting started

```bash
pnpm install            # installs every workspace member
pnpm --filter nanoclaw run dev
pnpm --filter gazoo run <script>
pnpm -r run build       # every package that defines the script
```

`fred/container/agent-runner/` is deliberately **not** a workspace member — it is
a Bun tree with its own `bun.lock`. See [`fred/docs/build-and-runtime.md`](fred/docs/build-and-runtime.md).
