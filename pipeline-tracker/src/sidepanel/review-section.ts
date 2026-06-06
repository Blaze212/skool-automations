// Spec 015 B2 — side-panel review UI.
//
// Renders the queue of low-confidence captures (outbox entries with
// `needs_review && !user_reviewed`) as editable cards above the unsynced-events
// list. The user can correct name / title / profile URL and Save, or approve a
// row as-is ("Sync this one"); a section-level "Sync all incl. ⚠" approves the
// whole queue. Approved rows flip `user_reviewed` (via the SW) and are released
// to the app on the next sync-pull.
//
// This module renders DOM and wires callbacks only — it never touches storage or
// recovered_html directly (D-rev-30). The caller (sidepanel.ts) routes the
// callbacks through the SW. All user text is written via textContent / input
// value (never innerHTML) so a hostile scraped value can't inject markup.

import type { OutboxEntry } from '../types.ts';
import { type EditableEventFields, labeledInput, labeledTextarea } from './editable-fields.ts';

export type ReviewEntryEdits = EditableEventFields;

export interface RenderReviewSectionOptions {
  /** Outbox entries awaiting review — caller pre-filters to needs_review && !user_reviewed. */
  entries: OutboxEntry[];
  /** Persist the user's corrections for one entry + approve it. */
  onSave: (historyId: string, edits: ReviewEntryEdits) => void | Promise<void>;
  /** Approve one entry as-is (no edits). */
  onSyncOne: (historyId: string) => void | Promise<void>;
  /** Approve every entry currently in the queue. */
  onSyncAll: (historyIds: string[]) => void | Promise<void>;
}

const REVIEW_HELP =
  'These captures looked off (missing or odd name / URL). Fix anything wrong and ' +
  'Save, or approve as-is. Until then they stay on your device and are not synced.';

export function renderReviewSection(root: HTMLElement, opts: RenderReviewSectionOptions): void {
  root.replaceChildren();

  const { entries } = opts;
  // Empty queue → render nothing. The section collapses to zero height so it
  // doesn't take up space when there's nothing to review.
  if (entries.length === 0) return;

  const section = document.createElement('section');
  section.className = 'section review-section';

  const header = document.createElement('div');
  header.className = 'section-head';

  const h2 = document.createElement('h2');
  h2.textContent = `Needs review`;
  header.appendChild(h2);

  const count = document.createElement('span');
  count.className = 'count review-count';
  count.textContent = `${entries.length}`;
  header.appendChild(count);

  const syncAll = document.createElement('button');
  syncAll.type = 'button';
  syncAll.className = 'review-sync-all-btn';
  syncAll.textContent = 'Sync all incl. ⚠';
  syncAll.addEventListener('click', () => {
    syncAll.disabled = true;
    void Promise.resolve(opts.onSyncAll(entries.map((e) => e.history_id))).catch((err: unknown) => {
      syncAll.disabled = false;
      console.warn('[Pipeline Tracker review] sync-all failed:', err);
    });
  });
  header.appendChild(syncAll);

  section.appendChild(header);

  const help = document.createElement('p');
  help.className = 'review-help';
  help.textContent = REVIEW_HELP;
  section.appendChild(help);

  const list = document.createElement('div');
  list.className = 'review-list';

  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'review-card row';
    card.dataset.historyId = entry.history_id;

    const head = document.createElement('div');
    head.className = 'review-card-head';
    const warn = document.createElement('span');
    warn.className = 'review-warn badge badge-warn';
    warn.textContent = '⚠';
    head.appendChild(warn);
    const headName = document.createElement('span');
    headName.className = 'name';
    headName.textContent = entry.event.name || '(no name)';
    head.appendChild(headName);
    card.appendChild(head);

    const { row: nameRow, input: nameInput } = labeledInput('Name', entry.event.name ?? '', 'name');
    const { row: titleRow, input: titleInput } = labeledInput(
      'Title',
      entry.event.title ?? '',
      'title',
    );
    const { row: urlRow, input: urlInput } = labeledInput(
      'Profile / page URL',
      // Wire-contract field name on the stored PipelineEvent.
      entry.event.profile_url ?? '',
      'profile_url',
    );
    const { row: messageRow, textarea: messageInput } = labeledTextarea(
      'Message',
      entry.event.message_text ?? '',
      'message_text',
    );
    card.append(nameRow, titleRow, urlRow, messageRow);

    const actions = document.createElement('div');
    actions.className = 'review-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'review-save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const edits: ReviewEntryEdits = {
        name: nameInput.value.trim(),
        title: titleInput.value.trim(),
        profile_url: urlInput.value.trim(),
        message_text: messageInput.value.trim(),
      };
      saveBtn.disabled = true;
      void Promise.resolve(opts.onSave(entry.history_id, edits)).catch((err: unknown) => {
        saveBtn.disabled = false;
        console.warn('[Pipeline Tracker review] save failed:', err);
      });
    });

    const syncOneBtn = document.createElement('button');
    syncOneBtn.type = 'button';
    syncOneBtn.className = 'review-sync-one-btn';
    syncOneBtn.textContent = 'Sync this one';
    syncOneBtn.addEventListener('click', () => {
      syncOneBtn.disabled = true;
      void Promise.resolve(opts.onSyncOne(entry.history_id)).catch((err: unknown) => {
        syncOneBtn.disabled = false;
        console.warn('[Pipeline Tracker review] sync-one failed:', err);
      });
    });

    actions.append(saveBtn, syncOneBtn);
    card.appendChild(actions);

    list.appendChild(card);
  }

  section.appendChild(list);
  root.appendChild(section);
}
