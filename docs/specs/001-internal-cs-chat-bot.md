# Brainstorm: Skool AI Chatbot Agent

## Context

CareerSystems runs its community on Skool. Members need guidance on job search strategy, navigating the community, and using the platform's tools (diagnostic, message generator). 

**The goal:** The group owner's Skool account (Katie's account) automatically replies to conversations it has context on — so members receive personal-feeling coaching from Katie, not a tagged bot. Members don't need to do anything differently.

**Phase 1:** Replies are drafted and queued for Katie's review. She edits if needed and hits "Send." Feature-flag-gated before full autopilot.

---

## Coaching Framework (System Prompt Foundation)

- **Constraint-based + stage-aware**: Every recommendation anchors to the member's diagnosed constraint (role / message / execution). That constraint determines which stage of the job search funnel to emphasize.
- **Tone**: Direct + warm — confident and specific, but genuinely supportive. Not clinical.
- **Gating logic:**
  - Billing/pricing → refer to Katie directly
  - Specific company/role advice → refer to Katie (out of scope until training data + quality gate exists)
  - Resume critique → point to workbook, message generator tool, or upcoming resume review calendar event
  - Legal/visa/HR → refer to Katie
  - $497 gated content for non-paying members → acknowledge by name, explain it's in the paid community, link upgrade page (`VITE_SKOOL_PURCHASE_URL`)

---

## Foundation: `skool-cli` (npm, MIT)

[https://www.npmjs.com/package/skool-cli](https://www.npmjs.com/package/skool-cli)

TypeScript package (v2.2.1) that wraps Skool's internal API using Playwright for auth. Covers core surfaces:

| Capability | Supported |
|---|---|
| Auth (email/password via Playwright) | ✓ |
| Chat: list conversations, read messages, send messages | ✓ |
| Posts: create/edit/delete, list categories | ✓ |
| Member monitoring + welcome DMs | ✓ |
| MCP Server mode (Claude tool use) | ✓ |
| Incoming DM polling / webhooks | ✗ — add |
| Post/comment monitoring | ✗ — add |

**Fork vs. dependency:** Use as an npm dep for stable operations; add a thin wrapper for polling and the reply pipeline. Fork only if library exports are missing.

---

## System Architecture

```
┌─────────────────────────────────────────────────┐
│              KNOWLEDGE LAYER                     │
│  Google Doc Workbook (RAG)  +  Skool Courses     │
│  Indexed in pgvector (Supabase)                  │
│  Synced on change / cron                         │
└────────────────────┬────────────────────────────┘
                     │ retrieved at reply time
                     ▼
┌─────────────────────────────────────────────────┐
│            DETECTION LAYER (polling)             │
│  Polling worker (cron edge fn or n8n)            │
│  Detects: new DMs, new posts, new members        │
│  Uses skool-cli under the hood                   │
└────────────────────┬────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
    New DM detected       New post/comment
          │                     │
          │               Classify: reply?
          │               (Claude Haiku — fast)
          │                     │
          └──────────┬──────────┘
                     ▼
          Fetch thread from Skool API
          + retrieve relevant KB chunks
          + member constraint from DB
                     │
                     ▼
          Draft reply — Claude Sonnet 4.6
          (system prompt + KB + thread context)
                     │
         ┌───────────┴───────────┐
         │  SKOOL_REPLY_MODE     │
         └───────────┬───────────┘
                     │
          review ────┴──── auto
           │                 │
           ▼                 ▼
    pending_skool_replies  Send via skool-cli
    (queue in DB)          immediately
           │
           ▼
    Portal /admin/replies
    Katie: edit → Send, or Dismiss
```

---

## Knowledge Layer (RAG)

### Google Doc Workbook (~35 pages)

The workbook is the primary reference. Members get deep links to specific sections rather than the root doc.

**Sync pipeline:**
1. Google Drive API webhook (or polling cron) detects doc changes
2. Fetch updated doc → split into sections by heading
3. Embed each section (OpenAI `text-embedding-3-small`)
4. Upsert into `workbook_chunks` table (pgvector)
5. Store `(section_title, anchor_link, embedding, content_hash)` per chunk

**At reply time:**
- Embed the incoming message → cosine similarity search → retrieve top 3–5 relevant sections
- Include section title + content in Claude's context window
- Claude cites the section and deep-links to it in the reply

**Script:** `scripts/sync-workbook.ts` — runnable manually or via cron

### Skool Courses & Community Structure

Course titles, module names, and Skool post categories need to be in the KB so the bot can direct members to the right content.

**Sync pipeline:**
1. Run via `skool-cli` or the API discovery script to list courses, modules, community categories
2. Store as structured JSON in `skool_content_index` table (or a static file re-generated on sync)
3. Include relevant course/module names in Claude's system prompt (small enough to fit in context)

**Script:** `scripts/sync-skool-content.ts` — runnable manually or via cron; output committed to `docs/skool-content-index.json`

### Standalone Step: Skool API Discovery

Captures Skool's full internal API surface via Playwright network interception. Independent of skool-cli — run this to find endpoints skool-cli doesn't expose.

**Script:** `scripts/discover-skool-api.ts`
**Output:** `docs/skool-api-discovery.json` (committed; diff on re-run highlights breaking changes)
**Run command:** `doppler run -- pnpm tsx scripts/discover-skool-api.ts`
**Re-run:** Manually when Skool behavior changes or breaks; quarterly as a sanity check.

---

## Database Objects

```sql
-- Chunked workbook content for RAG
CREATE TABLE workbook_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_title text NOT NULL,
  anchor_link text,           -- deep link to specific doc section
  content text NOT NULL,
  content_hash text NOT NULL,
  embedding vector(1536),     -- OpenAI text-embedding-3-small
  synced_at timestamptz DEFAULT now()
);
CREATE INDEX ON workbook_chunks USING ivfflat (embedding vector_cosine_ops);

-- Queued drafts awaiting human approval
CREATE TABLE pending_skool_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('dm', 'post', 'comment', 'onboarding')),
  skool_chat_id text,          -- for DMs; used to fetch thread on demand
  skool_post_id text,          -- for post/comment replies
  skool_member_id text NOT NULL,
  original_content text NOT NULL,
  draft_reply text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dismissed')),
  reviewed_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Prevent double-replying to posts
CREATE TABLE skool_post_replies (
  post_id text PRIMARY KEY,
  replied_at timestamptz DEFAULT now()
);
```

No conversation mirror — thread history fetched live from Skool's API at reply time.

---

## Interaction Surfaces

### 1. DM Chatbot
- **Detection:** Polling worker via skool-cli
- **Context:** Full DM thread (live from Skool API) + member constraint from DB + RAG chunks
- **Reply:** Claude Sonnet → queue or send

### 2. Community Post Responder
- **Detection:** Polling worker fetches recent posts; filters for unanswered questions
- **Classification:** Claude Haiku — "Is this in scope?" — confidence score ≥ `SKOOL_POST_REPLY_THRESHOLD` (start 0.85)
- **Reply:** Claude Sonnet → queue or send
- **Guard:** `skool_post_replies` prevents double-reply

### 3. Proactive Onboarding DM
- **Trigger:** Extend existing `webhook-skool` — after `upsertMemberProfile()` succeeds
- **Mode:** Auto-send (low risk; templated welcome + constraint quiz CTA)

---

## Approval UI: Portal `/admin/replies`

Single new route in `apps/portal`:
- Lists `pending_skool_replies` (status = 'pending'), newest first
- Shows: member name, original message, draft reply (editable inline)
- "Send" → calls `skool-reply-send` edge fn → skool-cli sends → marks 'sent'
- "Dismiss" → marks 'dismissed'
- Optional: deep-link to Skool chat for full context

No Skool UI rebuilt. Katie still operates in Skool normally.

---

## Feature Flag

```
SKOOL_REPLY_MODE=review   # queue all drafts for approval (Phase 1–3)
SKOOL_REPLY_MODE=auto     # send immediately (Phase 4+)
```

---

## New Components

| Component | Location | Purpose |
|---|---|---|
| `scripts/discover-skool-api.ts` | repo scripts | Playwright network capture → API catalogue |
| `scripts/sync-workbook.ts` | repo scripts | Google Doc → pgvector embeddings |
| `scripts/sync-skool-content.ts` | repo scripts | Skool courses/modules → content index |
| Polling worker | Edge fn or n8n cron | Detect new DMs + posts |
| `webhook-skool-chat` | `supabase/functions/` | DM detection → draft → queue/send |
| `webhook-skool-post` | `supabase/functions/` | Post detection → classify → draft → queue/send |
| `skool-reply-send` | `supabase/functions/` | Accept approved draft, send via skool-cli |
| `/admin/replies` | `apps/portal/` | Approval queue UI |

---

## New Env Vars (Doppler)

| Var | Purpose |
|---|---|
| `SKOOL_EMAIL` | Group owner login email |
| `SKOOL_PASSWORD` | Group owner login password |
| `SKOOL_REPLY_MODE` | `review` or `auto` |
| `SKOOL_POST_REPLY_THRESHOLD` | Min classifier confidence (e.g., `0.85`) |
| `GOOGLE_DOC_WORKBOOK_ID` | Drive document ID for workbook sync |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account creds for Drive API |

---

## Phased Rollout

| Phase | What ships | Mode |
|---|---|---|
| 0 — API Discovery | `discover-skool-api.ts`; validate skool-cli coverage | prereq |
| 1 — Onboarding DM | Extend `webhook-skool`; welcome DM on join | auto |
| 2 — Knowledge layer | `sync-workbook.ts`, `sync-skool-content.ts`, pgvector setup | prereq for 3+ |
| 3 — DM chatbot | `webhook-skool-chat` + polling + portal approval page | review |
| 4 — Post responder | `webhook-skool-post` + classifier | review |
| 5 — Auto mode | Flip `SKOOL_REPLY_MODE=auto` after quality proven | auto |

---

## Edge Cases & Mitigations

### 1. Google Doc changes and links are now wrong
**Scenario:** Katie renames a section heading or restructures the doc. The RAG chunks still reference old anchor links — bot sends a broken deep link.

**Mitigations:**
- `sync-workbook.ts` re-generates all anchor links on every sync run; stale links are replaced, not appended
- Store a `content_hash` per chunk; on sync, re-embed and re-anchor any chunk whose hash changed
- Run sync on a short cron (e.g., every 6 hours) so staleness window is bounded
- Claude should phrase resource links as "see the [Section Name] section of the workbook" rather than bare URLs when confidence is low — even if the anchor breaks, the name is useful

---

### 2. Member posts a new message after the draft is written but before Katie approves
**Scenario:** Member sends DM → bot drafts a reply → member sends a follow-up message → Katie approves the now-stale draft → reply doesn't address the latest message.

**Mitigations:**
- When Katie opens a pending reply, **re-fetch the latest thread state** from Skool API and show it alongside the draft — she can see if new messages arrived
- Surface a "thread updated" warning badge on the approval card if the Skool thread has newer messages than when the draft was created (compare timestamps)
- Option: automatically **regenerate the draft** if the thread has updated since the draft was written (requires re-triggering the pipeline on approve action)
- In `review` mode this is manageable; in `auto` mode this is a real risk — add a recency check before sending: if thread has new messages since draft generation, re-draft instead of sending

---

### 3. Member sends multiple messages in rapid succession
**Scenario:** Member sends 3 messages in 10 seconds (common on mobile). Polling worker picks up each one separately and generates 3 drafts.

**Mitigations:**
- **Debounce window**: When a new DM event is detected, wait N seconds (e.g., 30s) before triggering draft generation — allows burst messages to settle
- **One pending draft per chat**: Enforce a unique constraint on `(skool_chat_id, status='pending')` in `pending_skool_replies` — if a pending draft exists for that chat, cancel it and re-generate from the full updated thread
- Polling worker checks "is there already a pending draft for this chat?" before starting the pipeline

---

### 4. Katie manually replies in Skool before approving a queued draft
**Scenario:** Katie is in Skool and replies directly. Now there's a queued draft in the portal that's outdated — if approved, it sends a second reply on top of Katie's.

**Mitigations:**
- Before sending an approved draft, **check the thread's latest message** — if the last message is already from the group owner account, mark the draft 'dismissed' automatically and notify Katie
- Show a "Katie already replied" warning in the approval UI when this is detected
- Draft expiry: auto-dismiss pending drafts older than 24 hours

---

### 5. Bot replies to Katie's own messages (echo loop)
**Scenario:** Polling worker sees a message in a DM thread and doesn't realize it's from Katie's own account — drafts a reply to herself.

**Mitigations:**
- Filter all events where `sender_id == SKOOL_OWNER_ACCOUNT_ID` before entering the pipeline
- This is the first check in `webhook-skool-chat` — exit early if message is from owner

---

### 6. Two replies sent to the same post (race condition)
**Scenario:** Polling runs twice in quick succession (overlap); both detect the same unanswered post and generate drafts.

**Mitigations:**
- `skool_post_replies` table with `post_id` as primary key — insert on pipeline start (not on send); second insertion fails uniquely
- Use a DB advisory lock or `INSERT ... ON CONFLICT DO NOTHING` to make this idempotent

---

### 7. Member is non-paying but their access_state lookup fails
**Scenario:** DB lookup for membership tier errors or returns null — bot doesn't know whether to pitch the upgrade or give full access.

**Mitigations:**
- Default to treating unknown tier as **non-paying** (conservative) — never accidentally give away paid content
- Log the lookup failure with member ID; surface in portal alerts

---

### 8. Post is deleted before the bot replies
**Scenario:** Member posts a question, bot queues a draft, member deletes the post, Katie approves and sends — Skool API returns 404.

**Mitigations:**
- `skool-reply-send` checks for 404 response → marks draft 'dismissed' with reason 'post_deleted'
- No retry; surface to Katie via the approval UI

---

### 9. Skool rate-limits or bans the Playwright session
**Scenario:** Too many API calls → Skool throttles or flags the account.

**Mitigations:**
- Implement exponential backoff on all skool-cli calls
- Keep polling interval conservative (every 2–5 minutes, not seconds)
- Don't run concurrent polling workers
- Monitor for 429 / captcha responses; alert Katie if session is blocked

---

### 10. Draft reply exceeds Skool's message character limit
**Scenario:** Claude generates a reply that's too long for Skool's DM or comment field.

**Mitigations:**
- Instruct Claude in the system prompt: "Keep replies under 500 characters for DMs, 800 for post comments"
- Post-process: if draft exceeds limit, truncate at last sentence boundary and add "Let me know if you'd like more detail"
- Exact limit should be confirmed via API discovery script (observe max payload in captured traffic)

---

### 11. Skool internal API changes break skool-cli or our wrapper
**Scenario:** Skool ships an update; endpoints or payloads change; replies start failing silently.

**Mitigation:**
- Re-run `discover-skool-api.ts` on breakage; diff flags changed endpoints
- Monitor `skool-reply-send` for non-2xx responses; alert on spike
- Pin `skool-cli` version; update deliberately after testing

---

### 12. RAG returns stale workbook content
**Scenario:** Sync hasn't run since Katie updated the workbook; bot references content that's been changed or removed.

**Mitigations:**
- Run `sync-workbook.ts` on short cron (every 6 hours)
- Optionally trigger sync via Google Drive change webhook for immediate updates
- In `review` mode: Katie sees the draft and catches stale references before they go out

---

## Infrastructure Risks

| Risk | Mitigation |
|---|---|
| skool-cli missing programmatic exports | Fork and expose library API; contribute upstream |
| Playwright session expiry mid-operation | Re-auth on error; store session file securely via Doppler |
| Polling overlap (two workers running simultaneously) | Use a DB lock / scheduled task with single-instance guarantee |