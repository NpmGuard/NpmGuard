/**
 * The replay gallery — the index of audits that already ran.
 *
 * One route, and deliberately no `start` counterpart: a replay is not launched.
 * Its `auditId` streams on `/audit/{id}/events`, the same endpoint a live audit
 * uses, which is what keeps one renderer instead of a product one and a test one.
 */

import { ReplayGalleryResponseSchema, type ReplayGalleryResponse } from "@npmguard/shared";
import { apiBase } from "../../lib/config.ts";
import { getWire } from "../../lib/wire.ts";

export function fetchReplays(): Promise<ReplayGalleryResponse> {
  return getWire(`${apiBase()}/replays`, ReplayGalleryResponseSchema, "GET /replays");
}
