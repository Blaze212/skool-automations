// Default destination factory. The pipeline-tracker build script rewrites
// imports of this file to destination-impl.internal.ts or
// destination-impl.publishable.ts at bundle time (see the
// `destination-impl-target` esbuild plugin in build.ts). Tooling that does NOT
// go through that plugin — vitest, tsc, ad-hoc imports — falls through to the
// internal factory below, matching the historical default behavior.

export { createDestination } from './destination-impl.internal.ts';
