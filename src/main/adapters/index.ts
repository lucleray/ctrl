import type { ResourceAdapter } from "./adapter"
import { github } from "./github"
import { slack } from "./slack"
import { vercel } from "./vercel"

/**
 * Resource adapters, in Settings order. To add one, implement ResourceAdapter
 * (./adapter.ts) in its own file and list it here; to remove one, delete it
 * from this list. Settings can also turn each off.
 */
export const ADAPTERS: ResourceAdapter[] = [github, vercel, slack]
