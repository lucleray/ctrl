import { host, segments, slugTitle, type ResourceAdapter, type ResourceData, type ResourceType } from "./adapter"

const NOTION_ID = /([0-9a-f]{8})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{4})-?([0-9a-f]{12})$/i

const notionPage: ResourceType = {
  id: "notion-page",
  label: "Notion",
  icon: "doc",
  parse(url) {
    const h = host(url)
    if (h !== "notion.so" && h !== "notion.com" && !h.endsWith(".notion.so") && !h.endsWith(".notion.site") && !h.endsWith(".notion.com"))
      return null
    // Peek links (?p=<id>) point at the peeked page, not the database behind it.
    const peek = url.searchParams.get("p")?.match(NOTION_ID)
    const last = segments(url).at(-1) ?? ""
    const match = peek ?? last.match(NOTION_ID)
    if (!match) return null
    const id = match.slice(1).join("").toLowerCase()
    const data: ResourceData = { id }
    const slug = peek ? "" : slugTitle(last.slice(0, match.index))
    if (slug) data.title = slug
    return { identity: id, url: `https://www.notion.so/${id}`, data }
  },
  describe: (d) => (d.title ? { title: d.title } : { title: "Notion page", subtitle: d.id.slice(0, 8) }),
}

/** Links only: no live details. */
export const notion: ResourceAdapter = {
  id: "notion",
  name: "Notion",
  description: "Page links, titled from their URL",
  types: [notionPage],
}
