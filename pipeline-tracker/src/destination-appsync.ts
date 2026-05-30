// Spec 012 Phase 4 follow-up — publishable-build no-op destination.
//
// Publishable builds have no webhook host permission and no popup; events sit
// in the outbox until app.cmcareersystems.com calls the externally_connectable
// sync-pull handlers (wired in Phases 9-10). This strategy reflects that —
// every hook is a no-op. background.ts narrows on `kind` before calling any
// webhook-only method (deliverEventDirect, _resetDrainingForTests), so this
// interface stays minimal.

import type { PipelineEvent } from './types.ts';
import type { AppSyncDestination } from './destination.ts';

export class AppSyncStrategy implements AppSyncDestination {
  readonly kind = 'appsync' as const;

  async onEventCaptured(_event: PipelineEvent, _historyId: string): Promise<void> {
    // no-op — outbox is the pull surface for app.cmcareersystems.com.
  }

  async drainNow(): Promise<void> {
    // no-op — see above.
  }
}
