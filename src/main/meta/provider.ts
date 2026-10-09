import type { ProviderID, ResourceMeta } from "../../shared/types"

/** A resource to fetch: its key and the fields its URL gave (see src/shared/resources.ts). */
export type MetaRequest = { id: string; type: string; data: Record<string, string> }

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "no-cli" | "logged-out" | "rate-limited" | "network",
    /** When to try again (rate limits) */
    readonly retryAt?: number,
  ) {
    super(message)
  }
}

export type ProviderResult = {
  /** One entry per requested resource ({ missing: true } when it doesn't exist or isn't visible) */
  metas: Map<string, ResourceMeta>
  account?: string
  /** Shared budget as the service reports it, when it does */
  rate?: { remaining: number; limit: number; resetAt: number; cost: number }
}

/**
 * Fetches live details for the resource types that name it in `enrich`.
 * Auth comes from the service's own CLI, so ctrl has nothing to configure.
 */
export interface Provider {
  id: ProviderID
  /** Most resources per fetch() call */
  batchSize: number
  /** How long details stay fresh; Infinity = final, never refetched (not even when mentioned again) */
  ttl(type: string, meta: ResourceMeta): number
  fetch(batch: MetaRequest[]): Promise<ProviderResult>
  /** Forget the cached token (Retry, or after the service rejected it) */
  resetAuth(): void
}

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
