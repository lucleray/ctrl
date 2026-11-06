import { byRecency, host, segments, slugTitle, type ResourceAdapter, type ResourceData, type ResourceType } from "./adapter"

const linearIssue: ResourceType = {
  id: "linear-issue",
  label: "Linear issues",
  icon: "linear",
  parse(url) {
    if (host(url) !== "linear.app") return null
    const [workspace, kind, rawKey, slug] = segments(url)
    const key = rawKey?.toUpperCase()
    if (!workspace || kind !== "issue" || !key || !/^[A-Z][A-Z0-9]*-\d+$/.test(key)) return null
    const data: ResourceData = { workspace, key }
    if (slug) data.title = slugTitle(slug)
    return { identity: `${workspace.toLowerCase()}/${key}`, url: `https://linear.app/${workspace}/issue/${key}`, data }
  },
  describe: (d) => ({ title: d.key, subtitle: d.title }),
  // No live details: an issue counts as active while your sessions keep mentioning it.
  stage: ({ last }, { now }) => byRecency(last, now, 7),
}

/** Links only: no live details. */
export const linear: ResourceAdapter = {
  id: "linear",
  name: "Linear",
  description: "Issue links, titled from their URL",
  types: [linearIssue],
}
