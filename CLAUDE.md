# CLAUDE.md

See README.md for project overview and getting started.

## Tooling

| What            | Backend (`api/`)                                   | Frontend (`ui/`)                | Remotion (`remotion/`)                  |
| --------------- | -------------------------------------------------- | ------------------------------- | --------------------------------------- |
| Runtime         | Deno                                               | Node (via Vite)                 | Node (via Bun)                          |
| Package manager | `deno add jsr:@scope/package` / `deno add npm:pkg` | `cd ui && pnpm add pkg`         | `cd remotion && bun add pkg`            |
| Docs lookup     | `deno doc jsr:@zypher/agent`                       | —                               | —                                       |
| Linter          | `deno lint`                                        | `cd ui && pnpm lint` (ESLint)   | —                                       |
| Formatter       | `deno fmt`                                         | `cd ui && pnpm format` (Biome)  | —                                       |
| Type check      | `deno check main.ts`                               | `cd ui && pnpm typecheck`       | —                                       |
| Dev server      | `deno task dev`                                    | `cd ui && pnpm dev`             | `cd remotion && bun run dev`            |

## Restrictions

- Do NOT use npm/pnpm for backend deps — use `deno add` only.
- Do NOT use npm/yarn/deno for frontend deps — use `pnpm` only.
- Do NOT use Prettier — Biome is the formatter.
- Do NOT import from `@zypher/ui` JSR package. Use `@/lib/zypher-ui` instead
  (locally copied source).
- Do NOT replace the Zypher system prompt entirely — extend via
  `customInstructions` in `getSystemPrompt()`, or agent skills and programmatic
  tool calling will break.
- Do NOT manually edit `ui/pnpm-lock.yaml`.

## Vendored Code

These directories are ignored by ESLint and can be customized but are not
project-authored code:

- `ui/src/components/ui/` — shadcn/ui components
- `ui/src/components/ai-elements/` — chat UI components

`ui/src/lib/zypher-ui/` is also vendored (copied from `@zypher/ui` with inlined
types) but is linted. Edit `types.ts` if upstream types change.

## Adding shadcn Components

```sh
cd ui && pnpm dlx shadcn@latest add <component-name>
```

Browse available components: https://ui.shadcn.com/docs/components Config:
`ui/components.json` (style: new-york, icons: lucide).

## Common Changes

**New tool:** Create in `api/tools/`, register in `tools` array in
`api/agent.ts`. Run `deno doc jsr:@zypher/agent` for the Tool interface.

**New MCP server:** Add to `mcpServers` array in `api/agent.ts`. Types:
`"command"` (local process) or `"remote"` (HTTP endpoint).

**System prompt:** Modify `systemPromptLoader` in `api/agent.ts`. Always call
`getSystemPrompt()` as the base and pass custom instructions via
`customInstructions`. The Remotion skills are loaded automatically at startup.

**Frontend path alias:** `@/` maps to `ui/src/`.

## Architecture

Three processes run simultaneously:

1. **Port 3000** — Remotion Studio (`cd remotion && bun run dev`)
2. **Port 5173** — Vite chat UI (`cd ui && pnpm dev`)
3. **Port 8080** — Deno + Hono agent server (`deno task dev`)

In development, the browser connects to Hono (8080) which proxies Vite (5173)
for non-API requests. The Remotion Studio is embedded as an iframe.

## Remotion

Remotion video compositions live in `remotion/`:
- `remotion/src/` — composition source code
- `remotion/public/` — static assets (images, videos, fonts, audio)
- `remotion/remotion.config.ts` — Remotion config
- `remotion/server.ts` — optional server-side render server

## Remotion Skills

Remotion-specific coding skills are loaded from:
`agent/skills/remotion/skills/remotion/` (git submodule)

Update with: `bun run skills:update`
