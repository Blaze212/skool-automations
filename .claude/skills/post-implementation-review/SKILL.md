---
name: post-implementation-review
description: After implementing a spec/task, run verification, commit, push, open a PR, and request a Copilot review
---

## Post-Implementation Review Workflow

After implementing any spec file or completing a coding task, follow this workflow every time before considering the task done.

---

### Step 0 - Pull from main and rebase
Before starting work on a ticket, always pull the latest changes from main and rebase your branch to minimize merge conflicts later:

```bash
git checkout main
git pull origin main
## <Resolve any conflicts if they arise>
```

### Step 1 — Verification (fix any issues before committing)

Run these commands in order and fix any failures before proceeding (They should be auto run by Claude Code's end of turn checks, but run them manually to see details and fix issues before committing):

```bash
# 1. Type-check (Node apps + edge functions)
pnpm typecheck

# 2. Run package-level tests for any package you touched
#    e.g. pnpm --filter career-systems test -- <path-to-test-file>

# 3. Auto-format
pnpm format

# 4. Lint
pnpm lint

# 5. Run unit tests
pnpm test

# 6. Run integ tests
pnpm test:integ
```

Do **not** proceed to commit if any of these fail. Fix the issues first.

---

### Step 2 — Commit

Stage only the files you changed (never `git add -A` — avoid accidentally staging `.env` or lock files):

```bash
git add <specific files you changed>
git commit -m "<conventional commit message referencing the ticket ID>"
```

Use conventional commit format: `feat(TICKET-ID): short description`

---

### Step 3 — Push and open a PR

```bash
# Push the branch (use -u on first push to set upstream)
git push -u origin <branch-name>

# Open a PR targeting main
gh pr create \
  --title "<short PR title (under 70 chars)>" \
  --reviewer "Copilot" \
  --body "$(cat <<'EOF'
## Summary
- <bullet 1>
- <bullet 2>

## Test plan
- [ ] pnpm typecheck passes
- [ ] Unit tests pass
- [ ] pnpm lint passes

Closes <TICKET-ID>

🤖 Generated with Claude Code
EOF
)"
```

---

```bash


### Step 4 — Report back

After completing the above, output a brief summary:
- PR URL
- Branch name
- Which tests passed
- Which reviewer was requested
- If this was a spec implementation move the spec into "specs/implemented/" and update the status in the spec frontmatter
- If this was a Jira ticket, move the ticket to "In Review" and comment with the PR link and branch name

---

## When to use this skill

This workflow runs automatically **after every coding task** — any time you:
- Implement a spec file
- Complete a Jira ticket
- Make significant code changes

It is referenced in CLAUDE.md so it applies to every session.
