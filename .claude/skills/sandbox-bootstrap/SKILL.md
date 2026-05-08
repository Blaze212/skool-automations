---
name: sandbox-bootstrap
description: Known issues and workarounds for bootstrapping the Cowork sandbox (Ubuntu 22 aarch64). Reference this before running bootstrap-sandbox.sh in an overnight session.
---

## Sandbox environment

The Cowork sandbox runs **Ubuntu 22 aarch64 (ARM64 Linux)**. The bootstrap script is `scripts/bootstrap-sandbox.sh`.

Always override the default workspace path:

```bash
WORKSPACE=/sessions/<session-id>/mnt/workspace source scripts/bootstrap-sandbox.sh
```

---

## Known issues and workarounds

### Tool binaries (`scripts/bin/`)

Pre-built binaries must be **Linux arm64 (ELF aarch64)** — not macOS (Mach-O) and not x86-64. Verify with `file scripts/bin/<binary>` before use.

Required binaries:

- `deno` — Linux arm64 build from https://github.com/denoland/deno/releases (`deno-aarch64-unknown-linux-gnu.zip`)
- `gh` — Linux arm64 build from https://github.com/cli/cli/releases (`gh_*_linux_arm64.tar.gz`)
- `pnpm` / `pnpm.js` — shell wrapper + CJS bundle (no architecture dependency, but see pnpm note below)

### pnpm CJS/ESM issue

`scripts/bin/pnpm.js` is a CommonJS bundle. Because the workspace root has `"type": "module"` in `package.json`, Node.js treats `.js` files as ESM and the bundle fails. Fix: copy it to `/tmp/pnpm.cjs` and invoke it from outside the workspace root, then put a wrapper on `PATH`:

```bash
cp scripts/bin/pnpm.js /tmp/pnpm.cjs
printf '#!/bin/sh\nexec node /tmp/pnpm.cjs "$@"\n' > /tmp/pnpm
chmod +x /tmp/pnpm
export PATH="/sessions/<session-id>/mnt/workspace/scripts/bin:/tmp:$PATH"
```

### Git lock-file workaround

The workspace is a Docker bind-mount where `unlink` is not permitted (git lock cleanup fails). Copy `.git` to `/tmp` and use `GIT_DIR`/`GIT_WORK_TREE`:

```bash
SESSION_ID=<session-id>
WORKSPACE=/sessions/$SESSION_ID/mnt/workspace
mkdir -p /tmp/git-$SESSION_ID
cp -r $WORKSPACE/.git /tmp/git-$SESSION_ID/repo
export GIT_DIR=/tmp/git-$SESSION_ID/repo
export GIT_WORK_TREE=$WORKSPACE
rm -f $GIT_DIR/index.lock   # clear any stale lock before first use
```

### node_modules architecture

`node_modules` must be installed on the same OS/architecture as the sandbox (Linux arm64). If installed on macOS or x86-64, optional native packages like `@rollup/rollup-linux-arm64-gnu` will be absent and `vitest` / Vite builds will fail at startup. Re-run `pnpm install` inside the sandbox to fix.
