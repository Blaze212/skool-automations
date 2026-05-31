// Publishable-build destination factory. Selected by the
// destination-impl-target onResolve plugin in pipeline-tracker/build.ts when
// --target=publishable. Imports destination-appsync.ts only — destination-
// webhook.ts is never reached from this graph, so the WebhookAutoPushStrategy
// class, `performWebhookDelivery`, and the lone `fetch(` in the codebase are
// absent from the publishable bundle.

import { AppSyncStrategy } from './destination-appsync.ts';
import type { DestinationStrategy, WebhookStrategyDeps } from './destination.ts';

export function createDestination(_deps: WebhookStrategyDeps): DestinationStrategy {
  return new AppSyncStrategy();
}
