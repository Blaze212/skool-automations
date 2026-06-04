// Spec 015 B2 — shared editable-field builders for the side panel.
//
// Used by both the needs-review queue (review-section.ts) and the regular
// unsynced-events list (sidepanel.ts renderUnsynced), so a user can correct a
// capture's name / title / LinkedIn URL / message from either place. All user
// text is written via `value`/`textContent` (never innerHTML) so a hostile
// scraped value can't inject markup.

/** The four user-correctable fields on a captured event. */
export interface EditableEventFields {
  name: string;
  title: string;
  linkedin_url: string;
  message_text: string;
}

export function labeledInput(
  labelText: string,
  value: string,
  field: string,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'review-field';

  const span = document.createElement('span');
  span.className = 'review-field-label';
  span.textContent = labelText;
  row.appendChild(span);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'review-input';
  input.value = value;
  input.dataset.field = field;
  row.appendChild(input);

  return { row, input };
}

export function labeledTextarea(
  labelText: string,
  value: string,
  field: string,
): { row: HTMLElement; textarea: HTMLTextAreaElement } {
  const row = document.createElement('label');
  row.className = 'review-field';

  const span = document.createElement('span');
  span.className = 'review-field-label';
  span.textContent = labelText;
  row.appendChild(span);

  const textarea = document.createElement('textarea');
  textarea.className = 'review-input review-textarea';
  textarea.rows = 3;
  textarea.value = value;
  textarea.dataset.field = field;
  row.appendChild(textarea);

  return { row, textarea };
}

/**
 * Build the four editable field rows (Name / Title / LinkedIn URL / Message)
 * from a capture's current values. Returns the row elements to append and a
 * `getEdits()` reader that snapshots the (trimmed) current input values — the
 * shape `reviewOutboxEntry()` persists.
 */
export function buildEditableFields(values: EditableEventFields): {
  rows: HTMLElement[];
  getEdits: () => EditableEventFields;
} {
  const { row: nameRow, input: nameInput } = labeledInput('Name', values.name, 'name');
  const { row: titleRow, input: titleInput } = labeledInput('Title', values.title, 'title');
  const { row: urlRow, input: urlInput } = labeledInput(
    'LinkedIn URL',
    values.linkedin_url,
    'linkedin_url',
  );
  const { row: messageRow, textarea: messageInput } = labeledTextarea(
    'Message',
    values.message_text,
    'message_text',
  );

  return {
    rows: [nameRow, titleRow, urlRow, messageRow],
    getEdits: () => ({
      name: nameInput.value.trim(),
      title: titleInput.value.trim(),
      linkedin_url: urlInput.value.trim(),
      message_text: messageInput.value.trim(),
    }),
  };
}
