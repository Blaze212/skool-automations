// Internal-build destination factory. Selected by the destination-impl-target
// onResolve plugin in pipeline-tracker/build.ts when --target=internal, and
// also the fall-through for any tool path (vitest, tsc, ad-hoc REPL) that
// loads destination-impl.ts without going through the bundler.

import { WebhookAutoPushStrategy } from './destination-webhook.ts';
import type { DestinationStrategy, WebhookStrategyDeps } from './destination.ts';

export function createDestination(deps: WebhookStrategyDeps): DestinationStrategy {
  return new WebhookAutoPushStrategy(deps);
}
