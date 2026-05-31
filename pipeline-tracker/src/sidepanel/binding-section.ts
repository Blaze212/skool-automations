// Spec 012 Phase 7 — binding handshake UI (publishable build).
//
// Renders one of three states based on the persisted ExtensionBinding:
//   1. null → "Connect to CareerSystems" button (idle / disconnected)
//   2. status='pending' → "Connecting..." with a countdown to the 10-second
//      rollback. Per D-rev-12 the rollback timer lives here (side panel),
//      not in the SW, because port-open does NOT keep the SW alive in
//      Chrome 116+.
//   3. status='confirmed' → "Connected on YYYY-MM-DD" + Disconnect button.
//
// State-change architecture (post-code-review fix):
//
//   This module exposes a STABLE handle (returned from renderBindingSection)
//   that owns a fixed root subtree. The handle's body element is replaced in
//   place via setBinding(next) — root.replaceChildren is called ONCE on the
//   initial render and never again. Click handlers therefore close over the
//   same DOM element that any subsequent storage-driven re-render mutates;
//   handle.setError(msg) writes into the live body, not a detached prior
//   subtree.
//
//   The earlier design rebuilt the entire section on each storage event,
//   which made every click-handler continuation (delivered=0 message,
//   sendMessage rejection, rollback timer's error message) race the storage
//   listener: the SW's "pending" write fired storage.onChanged before the
//   awaited sendMessage resolved, replacing the section root and leaving the
//   click continuation writing errors into an orphaned body. The code review
//   for this PR caught it across all three angles.
//
// On panel re-open mid-handshake: a stale pending binding (older than the
// rollback window) is treated as a failed handshake and the UI surfaces an
// error + auto-clears.

import type { ExtensionBinding } from '../types.ts';

export const BIND_ROLLBACK_MS = 10_000;
/**
 * If the side panel re-opens and finds a `pending` binding older than this,
 * the user has already left the handshake stranded (SW respawn between port
 * messages, app tab closed mid-bind, etc.). Surface failure + clear.
 *
 * Set generously larger than BIND_ROLLBACK_MS so a re-render that races a
 * timer tick on the same panel doesn't treat itself as stale.
 */
export const BIND_PENDING_STALE_MS = 30_000;

export interface BindingSectionOptions {
  /** Current persisted binding, or null if unbound. */
  binding: ExtensionBinding | null;
  /** Ask the SW to start a fresh handshake. */
  startBinding: () => Promise<{ ok: boolean; message?: string; delivered?: number }>;
  /** Ask the SW to clear the persisted binding (Disconnect or rollback). */
  clearBinding: () => Promise<void>;
  /**
   * Open app.cmcareersystems.com in a new tab. Optional — when supplied,
   * the zero-tab error ("No CareerSystems tab is open…") renders an
   * actionable button alongside it (Phase 8 / D-rev-9).
   */
  openAppTab?: () => void;
  /** Inject a clock for tests. Defaults to Date.now / setTimeout / clearTimeout. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export interface BindingSectionHandle {
  /**
   * Re-render the body to reflect a new persisted binding. Called by
   * sidepanel.ts's storage.onChanged listener; safe to call from anywhere
   * since it mutates the body in place.
   */
  setBinding(next: ExtensionBinding | null): void;
  /**
   * Show a transient inline error inside the current body. Click handlers
   * use this to surface delivered=0 / sendMessage failures without rebuilding
   * the section — which would otherwise race with the storage-driven
   * re-render and leave the user with no explanation of the failure.
   */
  setError(message: string): void;
  /** Cancel any in-flight rollback timer + remove no-longer-needed listeners. */
  destroy(): void;
}

const STATUS_TEXT = {
  pending: 'Connecting…',
  confirmed: 'Connected',
} as const;

function formatBoundAtDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}

export function renderBindingSection(
  root: HTMLElement,
  opts: BindingSectionOptions,
): BindingSectionHandle {
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  // Build the stable section + body once. root.replaceChildren runs exactly
  // once here; subsequent state changes mutate `body` in place via
  // setBinding (which empties + repopulates body but never the section
  // or root).
  root.replaceChildren();
  const section = document.createElement('section');
  section.className = 'section binding-section';

  const header = document.createElement('div');
  header.className = 'section-header';
  const title = document.createElement('h2');
  title.textContent = 'CareerSystems sync';
  header.appendChild(title);
  section.appendChild(header);

  const body = document.createElement('div');
  body.className = 'binding-body';
  section.appendChild(body);

  // Error region lives at the section level, as a SIBLING of body — not
  // inside body. setBinding(next) replaces body's children to render the
  // new state, but errors persist across that replacement. This is the key
  // fix from the Phase 7 code review: a delivered=0 click resolves
  // `setError('No CareerSystems tab is open…')` AFTER the storage-driven
  // setBinding(null) has rebuilt the body, so the error must live outside
  // body to remain visible. Cleared explicitly by clearError() at the
  // start of each new click attempt.
  const errorRegion = document.createElement('div');
  errorRegion.className = 'binding-error';
  errorRegion.setAttribute('role', 'alert');
  errorRegion.hidden = true;
  section.appendChild(errorRegion);

  root.appendChild(section);

  let rollbackTimer: unknown | null = null;
  let inFlight = false;

  function clearRollbackTimer(): void {
    if (rollbackTimer !== null) {
      clearTimer(rollbackTimer);
      rollbackTimer = null;
    }
  }

  function setError(message: string): void {
    errorRegion.replaceChildren();
    errorRegion.textContent = message;
    errorRegion.hidden = false;
  }

  /**
   * Same as setError but appends an action button after the message. Used
   * by the zero-tab delivered=0 branch (Phase 8 D-rev-9) to render an
   * "Open CareerSystems" CTA that calls chrome.tabs.create.
   */
  function setErrorWithAction(message: string, actionLabel: string, onClick: () => void): void {
    errorRegion.replaceChildren();
    const msg = document.createElement('span');
    msg.textContent = message + ' ';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'binding-secondary';
    btn.textContent = actionLabel;
    btn.addEventListener('click', () => {
      try {
        onClick();
      } catch (err) {
        console.warn('[Pipeline Tracker binding-section] action handler threw:', err);
      }
    });
    errorRegion.append(msg, btn);
    errorRegion.hidden = false;
  }

  function clearError(): void {
    errorRegion.replaceChildren();
    errorRegion.textContent = '';
    errorRegion.hidden = true;
  }

  function renderUnbound(): void {
    body.replaceChildren();

    const explain = document.createElement('div');
    explain.className = 'binding-explain';
    explain.textContent =
      'Connect this extension to your CareerSystems account so the app can sync your captured ' +
      'events. You only need to do this once per browser profile.';
    body.appendChild(explain);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'binding-primary';
    btn.textContent = 'Connect to CareerSystems';
    btn.addEventListener('click', () => {
      if (inFlight) return;
      void initiateBinding(btn);
    });
    body.appendChild(btn);
  }

  function renderPending(binding: ExtensionBinding): void {
    body.replaceChildren();

    const status = document.createElement('div');
    status.className = 'binding-status binding-status-pending';
    status.textContent = STATUS_TEXT.pending;
    body.appendChild(status);

    const help = document.createElement('div');
    help.className = 'binding-help';
    help.textContent =
      'Open or focus your CareerSystems tab to finish connecting. Cancels automatically after 10 seconds.';
    body.appendChild(help);

    const countdown = document.createElement('div');
    countdown.className = 'binding-countdown';
    body.appendChild(countdown);

    const boundAt = Date.parse(binding.bound_at);
    if (Number.isNaN(boundAt)) {
      void rollbackToError('Connecting failed: invalid binding timestamp.');
      return;
    }
    const elapsed = Math.max(0, now() - boundAt);
    if (elapsed >= BIND_PENDING_STALE_MS) {
      countdown.textContent = '';
      void rollbackToError('Previous connection attempt expired. Try again.');
      return;
    }
    const remaining = Math.max(0, BIND_ROLLBACK_MS - elapsed);
    if (remaining === 0) {
      // Skip the transient 0s render — go straight to the error state so
      // the user doesn't see a "Connecting… 0s remaining" frame.
      void rollbackToError('Connection failed: timeout. Try again.');
      return;
    }
    countdown.textContent = `${Math.ceil(remaining / 1000)}s remaining`;
    rollbackTimer = setTimer(() => {
      rollbackTimer = null;
      void rollbackToError('Connection failed: timeout. Try again.');
    }, remaining);
  }

  function renderConfirmed(binding: ExtensionBinding): void {
    body.replaceChildren();

    const status = document.createElement('div');
    status.className = 'binding-status binding-status-confirmed';
    status.textContent = `${STATUS_TEXT.confirmed} on ${formatBoundAtDate(binding.bound_at)}`;
    body.appendChild(status);

    const help = document.createElement('div');
    help.className = 'binding-help';
    help.textContent =
      'Your CareerSystems app can pull captured events from this extension. Visit the app and ' +
      'click Sync there to deliver them.';
    body.appendChild(help);

    const disconnect = document.createElement('button');
    disconnect.type = 'button';
    disconnect.className = 'binding-secondary';
    disconnect.textContent = 'Disconnect';
    disconnect.addEventListener('click', () => {
      if (inFlight) return;
      void doClear(disconnect);
    });
    body.appendChild(disconnect);
  }

  function setBinding(next: ExtensionBinding | null): void {
    clearRollbackTimer();
    if (!next) renderUnbound();
    else if (next.status === 'pending') renderPending(next);
    else renderConfirmed(next);
  }

  async function initiateBinding(button: HTMLButtonElement): Promise<void> {
    inFlight = true;
    button.disabled = true;
    button.textContent = 'Connecting…';
    clearError();
    try {
      const result = await opts.startBinding();
      if (!result.ok) {
        setError(result.message ?? 'Could not start binding.');
        return;
      }
      if ((result.delivered ?? 0) === 0) {
        // SW persisted a pending binding but no app tab listened. Spec
        // D-rev-9: surface "Open CareerSystems first" with a CTA that
        // opens the app in a new tab. Clear the persisted pending so we
        // don't trip the panel's 10-s rollback on a different reload.
        await opts.clearBinding();
        const msg = 'No CareerSystems tab is open. Open one and try again.';
        if (opts.openAppTab) {
          setErrorWithAction(msg, 'Open CareerSystems', opts.openAppTab);
        } else {
          setError(msg);
        }
        return;
      }
      // Happy path: storage.onChanged listener drives the re-render to
      // pending. Nothing more for us to do here.
    } catch (err) {
      console.error('[Pipeline Tracker binding-section] startBinding threw:', err);
      setError('Could not start binding: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      inFlight = false;
    }
  }

  async function doClear(button: HTMLButtonElement): Promise<void> {
    inFlight = true;
    button.disabled = true;
    clearError();
    try {
      await opts.clearBinding();
      // Wait for storage.onChanged to drive the unbound render. If the
      // clearBinding turned out to be a no-op (Phase 8 'sync-first'
      // rebind-modal choice — opts.clearBinding resolves without writing
      // storage), the button stays in the same Connected DOM and we
      // must re-enable it here. setBinding(confirmed) would also re-
      // enable, but that doesn't fire when storage didn't change. The
      // unconditional re-enable in finally below covers both paths.
    } catch (err) {
      console.error('[Pipeline Tracker binding-section] clearBinding threw:', err);
      setError('Could not disconnect: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      // Always re-enable the button. The Phase 7 design left this in the
      // catch path only; Phase 8 review caught the 'sync-first' case
      // where neither catch nor a fresh setBinding(...) fires, stranding
      // the button disabled forever.
      button.disabled = false;
      inFlight = false;
    }
  }

  async function rollbackToError(message: string): Promise<void> {
    try {
      await opts.clearBinding();
    } catch (err) {
      console.warn('[Pipeline Tracker binding-section] rollback clearBinding threw:', err);
    }
    // Error lives in a section-level region (sibling of body), so it
    // survives the storage.onChanged listener's setBinding(null) re-render.
    setError(message);
  }

  // Drive the initial state.
  setBinding(opts.binding);

  return {
    setBinding,
    setError,
    destroy(): void {
      clearRollbackTimer();
    },
  };
}
