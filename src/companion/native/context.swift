// ctrl-context: tells the companion what's on screen. Ported from Orchid, an earlier prototype
// (its AccessibilityWindowSnapshotter and Slack parsers).
//
// Watches the frontmost app (activation notification + a 1s tick) and prints
// one JSON line on stdout whenever what it sees changes:
//
//   {"type":"permission","trusted":false}
//   {"type":"context","app":"Slack","bundleId":"…","title":"…","label":"#chan","urls":["https://…"]}
//   {"type":"hold","ctrl":true}   ⌃ alone pressed or released, from any app (the companion's ⌃1–9 hints)
//
// Everything runs on the main thread: the process does nothing else, AX calls
// time out after 150ms, and NSAppleScript wants the main thread.
//
//   ctrl-context --self-pid <pid>   ignore that app (ctrl itself): its windows keep the last context
//   ctrl-context --once [--debug]   scan the frontmost app once after 3s, print, exit (debugging)

import AppKit
import ApplicationServices
import Foundation

// MARK: - Output

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

struct Context: Equatable {
    var app: String
    var bundleID: String
    var title: String
    var label: String?
    var urls: [String]
    var debug: [String: String] = [:]

    static func == (a: Context, b: Context) -> Bool {
        a.app == b.app && a.bundleID == b.bundleID && a.title == b.title && a.label == b.label && a.urls == b.urls
    }

    func json(includeDebug: Bool) -> [String: Any] {
        var out: [String: Any] = ["type": "context", "app": app, "bundleId": bundleID, "title": title, "urls": urls]
        if let label { out["label"] = label }
        if includeDebug { out["debug"] = debug }
        return out
    }
}

// MARK: - Accessibility helpers

enum AX {
    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    static func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }

    static func string(_ value: CFTypeRef?) -> String? {
        if let string = value as? String { return string }
        if let url = value as? URL { return url.absoluteString }
        return nil
    }

    static func string(_ element: AXUIElement, _ name: String) -> String? {
        string(attribute(element, name))
    }

    static func children(_ element: AXUIElement) -> [AXUIElement] {
        (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    }

    static func app(_ pid: pid_t) -> AXUIElement {
        let application = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(application, 0.15)
        return application
    }

    static func focusedWindow(_ pid: pid_t) -> AXUIElement? {
        element(app(pid), kAXFocusedWindowAttribute)
    }

    static func focusedWindowTitle(_ pid: pid_t) -> String? {
        focusedWindow(pid).flatMap { string($0, kAXTitleAttribute) }
    }

    /// Electron and Chromium apps only build their accessibility tree once asked to.
    static func unlock(_ pid: pid_t) {
        let application = app(pid)
        AXUIElementSetAttributeValue(application, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(application, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    }

    static func frame(_ element: AXUIElement) -> CGRect? {
        guard let positionValue = attribute(element, kAXPositionAttribute),
              CFGetTypeID(positionValue) == AXValueGetTypeID(),
              let sizeValue = attribute(element, kAXSizeAttribute),
              CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: position, size: size)
    }
}

/// The focused window flattened to text, one AX string per line (deduped), plus what's under the pointer.
struct Snapshot {
    let windowTitle: String
    let text: String
    let lines: [Substring]
    /// Hover trace: DOM identifiers and strings of the element under the pointer and its ancestors
    let hover: String?
}

struct Snapshotter {
    // Caps keep a scan bounded on huge windows (long Slack channels, big Notion pages).
    static let maxDepth = 30
    static let maxNodes = 1_500
    static let maxCharacters = 150_000

    func snapshot(pid: pid_t, hover: (String) -> Bool) -> Snapshot? {
        let application = AX.app(pid)
        guard let window = AX.element(application, kAXFocusedWindowAttribute),
              let windowTitle = AX.string(window, kAXTitleAttribute) else { return nil }
        var values: [String] = []
        var seen = Set<String>()
        var nodes = 0
        var characters = 0
        if let focused = AX.element(application, kAXFocusedUIElementAttribute) {
            collect(focused, depth: 0, values: &values, seen: &seen, nodes: &nodes, characters: &characters)
        }
        collect(window, depth: 0, values: &values, seen: &seen, nodes: &nodes, characters: &characters)
        if seen.insert(windowTitle).inserted { values.insert(windowTitle, at: 0) }
        var hovered: String?
        if hover(windowTitle), let point = CGEvent(source: nil)?.location {
            hovered = hoverTrace(pid: pid, at: point)
        }
        let text = values.joined(separator: "\n")
        return Snapshot(
            windowTitle: windowTitle,
            text: text,
            lines: text.split(separator: "\n", omittingEmptySubsequences: false),
            hover: hovered
        )
    }

    private func collect(
        _ element: AXUIElement, depth: Int, values: inout [String], seen: inout Set<String>, nodes: inout Int,
        characters: inout Int
    ) {
        guard depth <= Self.maxDepth, nodes < Self.maxNodes, characters < Self.maxCharacters else { return }
        nodes += 1
        if let hidden = AX.attribute(element, kAXHiddenAttribute) as? Bool, hidden { return }
        for name in [
            kAXURLAttribute, kAXSelectedTextAttribute, kAXValueAttribute, kAXTitleAttribute,
            kAXDescriptionAttribute, kAXIdentifierAttribute, "AXDOMIdentifier",
        ] {
            guard let string = AX.string(element, name), !string.isEmpty, string.count <= 20_000,
                  seen.insert(string).inserted else { continue }
            values.append(string)
            characters += string.count
        }
        for child in AX.children(element) {
            collect(child, depth: depth + 1, values: &values, seen: &seen, nodes: &nodes, characters: &characters)
        }
    }

    /// Hit-tests the app's own tree (never system-wide, which could query ctrl's) and walks up
    /// to 12 ancestors until a broad container, keeping their DOM identifiers and strings.
    private func hoverTrace(pid: pid_t, at point: CGPoint) -> String? {
        let application = AX.app(pid)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &hit) == .success,
              var current = hit else { return nil }
        var hitPid: pid_t = 0
        guard AXUIElementGetPid(current, &hitPid) == .success, hitPid == pid else { return nil }
        let hoveredStrings = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute]
            .compactMap { AX.string(current, $0)?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count >= 4 }
        var trace: [String] = []
        for _ in 0..<12 {
            let role = AX.string(current, kAXRoleAttribute)
            for name in [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute, "AXDOMIdentifier", kAXURLAttribute] {
                if let value = AX.string(current, name), !value.isEmpty { trace.append(String(value.prefix(1_000))) }
            }
            if let role, ["AXApplication", "AXList", "AXScrollArea", "AXWebArea", "AXWindow"].contains(role) {
                trace.append(contentsOf: semanticIdentifiers(containing: point, matching: hoveredStrings, in: current))
                break
            }
            guard let parent = AX.element(current, kAXParentAttribute), !CFEqual(parent, current) else { break }
            current = parent
        }
        return trace.joined(separator: "\n")
    }

    /// Slack Threads cards (`threads_view_…`) under the pointer, or whose text matches what's hovered.
    private func semanticIdentifiers(containing point: CGPoint, matching hovered: [String], in element: AXUIElement) -> [String] {
        var identifiers: [String] = []
        var nodes = 0
        func walk(_ element: AXUIElement, ancestors: [String], depth: Int) {
            guard depth <= Self.maxDepth, nodes < Self.maxNodes else { return }
            nodes += 1
            let identifier = AX.string(element, "AXDOMIdentifier")
            let semantic = identifier?.hasPrefix("threads_view_") == true
            let chain = semantic ? ancestors + [identifier!] : ancestors
            if semantic, AX.frame(element)?.contains(point) == true { identifiers.append(identifier!) }
            let strings = [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute]
                .compactMap { AX.string(element, $0)?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { $0.count >= 4 }
            if strings.contains(where: { value in hovered.contains(where: { value == $0 || value.contains($0) }) }) {
                identifiers.append(contentsOf: chain)
            }
            for child in AX.children(element) { walk(child, ancestors: chain, depth: depth + 1) }
        }
        walk(element, ancestors: [], depth: 0)
        var seen = Set<String>()
        return identifiers.filter { seen.insert($0).inserted }
    }

    /// AXURL of the first element with this DOM id (Notion's `notion-app`).
    func url(forDOMIdentifier target: String, in element: AXUIElement) -> String? {
        var nodes = 0
        func walk(_ element: AXUIElement, depth: Int) -> String? {
            guard depth <= Self.maxDepth, nodes < Self.maxNodes else { return nil }
            nodes += 1
            if AX.string(element, "AXDOMIdentifier") == target, let url = AX.string(element, kAXURLAttribute) { return url }
            for child in AX.children(element) {
                if let url = walk(child, depth: depth + 1) { return url }
            }
            return nil
        }
        return walk(element, depth: 0)
    }

    /// AXURL of the window's first web area: the page an Electron app shows.
    func webAreaURL(in element: AXUIElement) -> String? {
        var nodes = 0
        var queue = [element]
        while !queue.isEmpty, nodes < Self.maxNodes {
            let next = queue.removeFirst()
            nodes += 1
            if AX.string(next, kAXRoleAttribute) == "AXWebArea", let url = AX.string(next, kAXURLAttribute),
               url.hasPrefix("http") {
                return url
            }
            queue.append(contentsOf: AX.children(next))
        }
        return nil
    }
}

// MARK: - URL helpers

let urlPattern = try! NSRegularExpression(pattern: #"https?://[^\s<>\"'|\\\]]+"#, options: [.caseInsensitive])

func urls(in text: String) -> [String] {
    let range = NSRange(text.startIndex..., in: text)
    return urlPattern.matches(in: text, range: range).compactMap { match in
        Range(match.range, in: text).map { String(text[$0]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;:!?)]}")) }
    }
}

func firstMatch(_ pattern: String, in text: String) -> [String]? {
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) else { return nil }
    return (0..<match.numberOfRanges).map { i in
        Range(match.range(at: i), in: text).map { String(text[$0]) } ?? ""
    }
}

// MARK: - Browsers

/// Chromium browsers share Chrome's AppleScript dictionary.
let chromium: [String: String] = [
    "com.google.Chrome": "Chrome",
    "com.google.Chrome.beta": "Chrome",
    "com.google.Chrome.dev": "Chrome",
    "com.google.Chrome.canary": "Chrome",
    "org.chromium.Chromium": "Chromium",
    "com.brave.Browser": "Brave",
    "com.microsoft.edgemac": "Edge",
    "com.vivaldi.Vivaldi": "Vivaldi",
    "company.thebrowser.Browser": "Arc",
    "company.thebrowser.dia": "Dia",
]
let safari: [String: String] = [
    "com.apple.Safari": "Safari",
    "com.apple.SafariTechnologyPreview": "Safari",
]

var scripts: [String: NSAppleScript] = [:]

/// Active tab's URL and title. Only asked of the frontmost app, so it never launches one.
func browserTab(bundleID: String) -> (url: String, title: String)? {
    let source: String
    if chromium[bundleID] != nil {
        source = """
        tell application id "\(bundleID)"
          if (count of windows) is 0 then return ""
          set t to active tab of front window
          return (URL of t) & linefeed & (title of t)
        end tell
        """
    } else {
        source = """
        tell application id "\(bundleID)"
          if (count of documents) is 0 then return ""
          return (URL of front document) & linefeed & (name of front document)
        end tell
        """
    }
    let script = scripts[bundleID] ?? NSAppleScript(source: source)!
    scripts[bundleID] = script
    var error: NSDictionary?
    guard let value = script.executeAndReturnError(&error).stringValue, !value.isEmpty else { return nil }
    let parts = value.components(separatedBy: "\n")
    return (parts[0], parts.dropFirst().joined(separator: "\n"))
}

// MARK: - Slack

enum Slack {
    static let bundleID = "com.tinyspeck.slackmacgap"

    static func isThreadsPage(_ title: String) -> Bool {
        title.hasPrefix("Threads - ") && title.contains(" - Slack")
    }

    /// "general (Channel) - Acme - 2 new items - Slack [Main]" → ("general", "Channel")
    static func titleParts(_ title: String) -> (name: String, kind: String?)? {
        if let m = firstMatch(#"^(.+?) \((Channel|DM|Group DM|Private channel)\) - .+ - Slack"#, in: title) {
            return (m[1], m[2])
        }
        let first = title.components(separatedBy: " - ").first ?? ""
        return first.isEmpty || first == "Slack" ? nil : (first, nil)
    }

    /// Slack's own client URL names the channel on screen: app.slack.com/client/<team>/<channel>
    static func clientChannelID(in snapshot: Snapshot) -> String? {
        for url in urls(in: snapshot.text) {
            if let m = firstMatch(#"^https://app\.slack\.com/client/[A-Z0-9]+/([A-Z][A-Z0-9]{2,})"#, in: url) { return m[1] }
        }
        return nil
    }

    /// Workspace subdomain from any permalink on screen, else from the window title (fragile: display name).
    static func workspace(in snapshot: Snapshot) -> String {
        for url in urls(in: snapshot.text) {
            if let m = firstMatch(#"^https://([a-z0-9][a-z0-9-]*)(?:\.enterprise)?\.slack\.com/archives/"#, in: url) {
                return m[1]
            }
        }
        let parts = snapshot.windowTitle.components(separatedBy: " - ")
        if parts.count >= 3 {
            let slug = parts[1].lowercased().replacingOccurrences(of: " ", with: "-")
                .filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
            if !slug.isEmpty { return slug }
        }
        return "slack"
    }

    /// The channel most message links on screen point to.
    static func permalinkChannel(in snapshot: Snapshot) -> String? {
        var counts: [String: Int] = [:]
        for url in urls(in: snapshot.text) where isMessageURL(url) {
            if let m = firstMatch(#"/archives/([A-Z][A-Z0-9]{2,})/p"#, in: url) { counts[m[1], default: 0] += 1 }
        }
        return counts.max(by: { $0.value < $1.value })?.key
    }

    static func isMessageURL(_ url: String) -> Bool {
        firstMatch(#"^https://[a-z0-9-]+(?:\.enterprise)?\.slack\.com/archives/[A-Z][A-Z0-9]{2,}/p[0-9]{10,20}"#, in: url) != nil
    }

    /// Thread side panel: the first permalink after "Thread in channel <name>" is the open thread
    /// (messages above the marker belong to the channel).
    static func sidePanelThread(_ lines: [Substring]) -> (url: String, channel: String)? {
        guard let marker = lines.firstIndex(where: { $0.hasPrefix("Thread in channel ") }) else { return nil }
        for line in lines[marker...] {
            if let url = urls(in: String(line)).first(where: isMessageURL) {
                return (url, String(lines[marker].dropFirst("Thread in channel ".count)))
            }
        }
        return nil
    }

    /// Threads page: the card under the pointer, from its DOM id `threads_view_[root-|footer-…]<C>-<ts>`.
    static func hoveredThread(_ snapshot: Snapshot) -> (url: String, channel: String?)? {
        guard let hover = snapshot.hover,
              let m = firstMatch(
                #"threads_view_(?:(?:footer|root|heading|load_older)-)?([A-Z][A-Z0-9]{2,})-([0-9]{10,20}\.[0-9]{1,12})(?:-|\s|$)"#,
                in: hover
              ) else { return nil }
        let (channelID, ts) = (m[1], m[2])
        let url = "https://\(workspace(in: snapshot)).slack.com/archives/\(channelID)/p\(ts.replacingOccurrences(of: ".", with: ""))"
        let prefix = "Reply to thread in "
        func replyChannel<S: Sequence>(_ lines: S) -> String? where S.Element == Substring {
            for line in lines {
                if let r = line.range(of: prefix) {
                    let name = line[r.upperBound...].trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty { return name }
                }
            }
            return nil
        }
        var channel = replyChannel(hover.split(separator: "\n"))
        if channel == nil, let footer = snapshot.lines.firstIndex(where: { $0 == "threads_view_footer-\(channelID)-\(ts)" }) {
            channel = replyChannel(snapshot.lines[footer...].prefix(20))
        }
        return (url, channel)
    }

    /// The Threads page shows many threads: keep the last hovered one until another is.
    static var stickyThread: (url: String, channel: String?)?

    static func context(pid: pid_t, snapshotter: Snapshotter) -> Context? {
        AX.unlock(pid)
        guard let snapshot = snapshotter.snapshot(pid: pid, hover: isThreadsPage) else { return nil }
        // Focus moved mid-scan (another channel or window): drop it, the next tick rescans.
        guard AX.focusedWindowTitle(pid) == snapshot.windowTitle else { return nil }
        var ctx = Context(app: "Slack", bundleID: bundleID, title: snapshot.windowTitle, label: nil, urls: [])
        if isThreadsPage(snapshot.windowTitle) {
            if let hovered = hoveredThread(snapshot) {
                // Some hover spots on a card don't carry its channel name: keep the one we had for it.
                let channel = hovered.channel ?? (stickyThread?.url == hovered.url ? stickyThread?.channel : nil)
                stickyThread = (hovered.url, channel)
            }
            if let thread = stickyThread {
                ctx.urls = [thread.url]
                ctx.label = thread.channel.map { "Thread in #\($0)" } ?? "Thread"
            } else {
                ctx.label = "Threads (hover one)"
            }
            if debugging {
                ctx.debug["hover"] = snapshot.hover ?? ""
                ctx.debug["text"] = snapshot.text
            }
            return ctx
        }
        stickyThread = nil
        let parts = titleParts(snapshot.windowTitle)
        // Switching channels, Slack updates the content (and its client URL) before the window title:
        // until the header and the title agree, the URL may belong to the next channel. The next tick rescans.
        let header = snapshot.lines.first(where: { $0.hasPrefix("Channel details for #") })
            .map { String($0.dropFirst("Channel details for #".count)) }
        // Compared loosely: the title can carry a prefix the header doesn't ("! announcements-engineering").
        let loose = { (v: String) in v.lowercased().filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } }
        if let header, let parts, parts.kind != nil, !loose(parts.name).hasSuffix(loose(header)) { return nil }
        let channelName = header.map { "#\($0)" }
            ?? parts.map { $0.kind == "Channel" || $0.kind == "Private channel" ? "#\($0.name)" : $0.name }
        if let thread = sidePanelThread(snapshot.lines) {
            ctx.urls.append(thread.url)
            ctx.label = "Thread in #\(thread.channel)"
        }
        // A DM opened from Activity keeps the Activity client URL: fall back to the channel its messages link to.
        if let channelID = clientChannelID(in: snapshot) ?? (parts?.kind != nil ? permalinkChannel(in: snapshot) : nil) {
            ctx.urls.append("https://\(workspace(in: snapshot)).slack.com/archives/\(channelID)")
        }
        if ctx.label == nil { ctx.label = channelName }
        if debugging {
            ctx.debug["clientChannel"] = clientChannelID(in: snapshot) ?? ""
            ctx.debug["text"] = snapshot.text
        }
        return ctx
    }
}

// MARK: - Notion, Linear

func notionContext(pid: pid_t, snapshotter: Snapshotter) -> Context? {
    AX.unlock(pid)
    guard let window = AX.focusedWindow(pid), let title = AX.string(window, kAXTitleAttribute) else { return nil }
    var ctx = Context(app: "Notion", bundleID: "notion.id", title: title, label: title, urls: [])
    // notion-app's AXURL can lag on the previous tab, so it only counts when its slug matches the title.
    if let raw = snapshotter.url(forDOMIdentifier: "notion-app", in: window) ?? snapshotter.webAreaURL(in: window) {
        let url = raw.components(separatedBy: "#")[0]
        let normalize = { (s: String) in String(s.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains)) }
        let slug = URL(string: url)?.lastPathComponent.replacingOccurrences(
            of: #"-?[0-9a-f]{32}$"#, with: "", options: .regularExpression) ?? ""
        let peek = url.contains("?p=") || url.contains("&p=")
        if peek || slug.isEmpty || normalize(slug) == normalize(title) { ctx.urls = [url] }
        ctx.debug["internalURL"] = raw
    }
    return ctx
}

func linearContext(pid: pid_t, snapshotter: Snapshotter) -> Context? {
    AX.unlock(pid)
    guard let window = AX.focusedWindow(pid), let title = AX.string(window, kAXTitleAttribute) else { return nil }
    var ctx = Context(app: "Linear", bundleID: "com.linear", title: title, label: title, urls: [])
    if let url = snapshotter.webAreaURL(in: window) { ctx.urls = [url] }
    return ctx
}

// MARK: - Loop

final class Watcher {
    let selfPid: pid_t
    let snapshotter = Snapshotter()
    var last: Context?
    var lastTrusted: Bool?
    var busy = false

    init(selfPid: pid_t) { self.selfPid = selfPid }

    func scan(frontmost app: NSRunningApplication) -> Context? {
        let bundleID = app.bundleIdentifier ?? ""
        let pid = app.processIdentifier
        let name = app.localizedName ?? bundleID
        if let browser = chromium[bundleID] ?? safari[bundleID] {
            guard let tab = browserTab(bundleID: bundleID) else {
                return Context(app: browser, bundleID: bundleID, title: "", label: nil, urls: [])
            }
            // No label: the companion names the recognized link instead (tab titles are long).
            return Context(app: browser, bundleID: bundleID, title: tab.title, label: nil, urls: [tab.url])
        }
        guard AXIsProcessTrusted() else { return Context(app: name, bundleID: bundleID, title: "", label: nil, urls: []) }
        switch bundleID {
        case Slack.bundleID: return Slack.context(pid: pid, snapshotter: snapshotter)
        case "notion.id": return notionContext(pid: pid, snapshotter: snapshotter)
        case "com.linear": return linearContext(pid: pid, snapshotter: snapshotter)
        default:
            return Context(app: name, bundleID: bundleID, title: AX.focusedWindowTitle(pid) ?? "", label: nil, urls: [])
        }
    }

    func tick() {
        let trusted = AXIsProcessTrusted()
        if trusted != lastTrusted {
            lastTrusted = trusted
            emit(["type": "permission", "trusted": trusted])
            if trusted { ControlHold.start() }
        }
        guard !busy, let app = NSWorkspace.shared.frontmostApplication else { return }
        // ctrl itself (the companion or the main window): keep showing what was there before.
        if app.processIdentifier == selfPid || app.processIdentifier == getpid() { return }
        busy = true
        defer { busy = false }
        guard let ctx = scan(frontmost: app) else { return }
        // The scan took a while and another app came forward: its own tick will report it.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return }
        if ctx != last {
            last = ctx
            emit(ctx.json(includeDebug: false))
        }
    }
}

// MARK: - ⌃ held

/// Reports ⌃ held on its own (no ⌥⇧⌘), so the companion can show its ⌃1–9 hints like the main window's ⌘1–9.
/// A global monitor sees other apps' keys only with Accessibility (it starts once granted) and needs NSApp.run().
enum ControlHold {
    static var monitor: Any?
    static var held = false

    static func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { event in
            let flags = event.modifierFlags.intersection([.control, .option, .shift, .command])
            let now = flags == .control
            if now != held {
                held = now
                emit(["type": "hold", "ctrl": now])
            }
        }
    }
}

let args = CommandLine.arguments
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let selfPid = pid_t(option("--self-pid") ?? "") ?? -1
let debugging = args.contains("--debug")
let watcher = Watcher(selfPid: selfPid)

if args.contains("--once") {
    // Gives you time to switch to the app to inspect.
    Thread.sleep(forTimeInterval: Double(option("--delay") ?? "3") ?? 3)
    emit(["type": "permission", "trusted": AXIsProcessTrusted()])
    // --app <bundle id> reads that app even in the background (no hover), so testing never takes focus.
    let target = option("--app").flatMap { NSRunningApplication.runningApplications(withBundleIdentifier: $0).first }
        ?? NSWorkspace.shared.frontmostApplication
    if let app = target, let ctx = watcher.scan(frontmost: app) {
        emit(ctx.json(includeDebug: args.contains("--debug")))
    }
    exit(0)
}

// ctrl closing our stdin (quit, crash, setting turned off) means stop.
FileHandle.standardInput.readabilityHandler = { handle in
    if handle.availableData.isEmpty { exit(0) }
}
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { _ in watcher.tick() }
Timer.scheduledTimer(withTimeInterval: Double(option("--interval") ?? "1") ?? 1, repeats: true) { _ in watcher.tick() }
watcher.tick()
// An app run loop, not RunLoop.main: global event monitors are delivered through NSApp. No Dock icon.
NSApplication.shared.setActivationPolicy(.prohibited)
NSApp.run()
