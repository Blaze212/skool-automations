# @cs/scraping-core

Shared LinkedIn DOM extraction. No `chrome.*` imports — DOM access happens via the `document`
handle passed into `extract()`. Consumed by `pipeline-tracker` (and, per spec 012, the
publishable build + per spec 013 the on-device AI fallback).
