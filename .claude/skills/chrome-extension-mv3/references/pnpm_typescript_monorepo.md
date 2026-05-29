---
name: pnpm-typescript-monorepo
description: "pnpm workspaces + TypeScript project references — current monorepo best practice (2026). workspace protocol, composite builds, incremental tsc."
metadata: 
  node_type: memory
  type: reference
  originSessionId: c555efb5-25ee-45b8-be2d-d52f7f9603eb
---

# pnpm workspaces + TypeScript monorepo (verified 2026-05-29)

## Foundation

- **pnpm workspaces** + **TypeScript project references** is the recommended monorepo stack.
- Optional layer: **Turborepo** or **Nx** for task orchestration. Skip until needed; pnpm
  scripts can do a lot.
- Optional layer: **Biome** or **ESLint** + **Prettier** — repo choice.

## `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
  - 'apps/*'
```

Lives at repo root. pnpm discovers each `package.json` under the globbed paths.

## Workspace protocol for cross-package deps

```json
{
  "dependencies": {
    "@cs/scraping-core": "workspace:*"
  }
}
```

- `workspace:*` resolves to the local package, never to a registry version.
- `workspace:^` and `workspace:~` pin to compatible local versions.
- When publishing, pnpm rewrites these to actual version numbers.

## TypeScript project references

Root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/scraping-core" },
    { "path": "./pipeline-tracker" }
  ]
}
```

Each package's `tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../scraping-core" }
  ]
}
```

- `composite: true` is mandatory for any package referenced by another.
- Build with `tsc --build` (incremental) instead of plain `tsc`.
- TypeScript reuses `.tsbuildinfo` cache for unchanged packages.

## Type checking

- `pnpm --recursive typecheck` runs `tsc --build` in each package; fast when most are
  unchanged.
- Filter to a single package: `pnpm --filter @cs/scraping-core typecheck`.

## Common pitfalls

- Forgetting `composite: true` → "Referenced project must have setting 'composite': true."
- Mixing `paths` aliases with project references → use one or the other; references is the
  scaleable choice.
- Importing from a workspace package without listing it in `dependencies` → resolves
  accidentally via hoisting; fails when published. Always list it.
- Running `tsc` (not `tsc --build`) in a project-references setup → produces output but
  doesn't update referenced packages first.

## When to apply

- Adding a second consumer of shared code (a sibling extension, a CLI, a backend module
  that mirrors a frontend type).
- Setting up incremental CI builds — project references + `tsc --build` is the path to
  sub-second type-checking on touched packages only.

## Don'ts

- Don't add Turborepo / Nx until pnpm scripts feel slow.
- Don't use `paths` for cross-package imports — use the `workspace:` protocol.
- Don't commit `.tsbuildinfo` files; gitignore them.
