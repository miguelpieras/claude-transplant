import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// This helper reads the selected document. It does not press document controls,
// edit a document, or use a saved export when Claude cannot be read.
enum ProjectArtifactExporter {
    struct Failure: Error { let message: String }
    struct Content: Equatable {
        let text: String
        let links: [[String: String]]
        static func == (a: Content, b: Content) -> Bool { a.text == b.text && a.links == b.links }
    }
    static let uuidPattern = "^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$"
    static func validUUID(_ value: String) -> Bool { value.range(of: uuidPattern, options: [.regularExpression, .caseInsensitive]) != nil }
    static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    static func string(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
    static func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
    static func nodes(_ root: AXUIElement) throws -> [AXUIElement] {
        var pending = [root], result: [AXUIElement] = []
        while let node = pending.popLast() {
            guard result.count < 50000 else { throw Failure(message: "The document accessibility tree is too large. No report was exported.") }
            result.append(node)
            pending.append(contentsOf: children(node).reversed())
        }
        return result
    }
    static func base58(_ id: String) -> String {
        let hex = id.replacingOccurrences(of: "-", with: "")
        var bytes: [Int] = []
        var cursor = hex.startIndex
        while cursor < hex.endIndex {
            let next = hex.index(cursor, offsetBy: 2)
            bytes.append(Int(hex[cursor..<next], radix: 16) ?? 0)
            cursor = next
        }
        let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
        var digits = ""
        while bytes.contains(where: { $0 != 0 }) {
            var remainder = 0
            for index in bytes.indices {
                let value = remainder * 256 + bytes[index]
                bytes[index] = value / 58
                remainder = value % 58
            }
            digits.insert(alphabet[remainder], at: digits.startIndex)
        }
        return String(repeating: "1", count: max(0, 22 - digits.count)) + digits
    }
    static func address(_ node: AXUIElement) -> URL? {
        let value = attribute(node, kAXURLAttribute)
        if let url = value as? URL { return url }
        return (value as? String).flatMap(URL.init(string:))
    }
    static func matches(_ url: URL, id: String, shortID: String) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        if host == "claude.ai" || host == "claude.com" {
            let validPrefix = ["/artifact/", "/code/artifact/", "/code/frame/", "/epitaxy/artifact/"].contains { url.path.hasPrefix($0) }
            guard validPrefix else { return false }
            let name = url.lastPathComponent
            return name.lowercased() == id.lowercased() || name == shortID || name.lowercased().hasSuffix("-" + id.lowercased()) || name.hasSuffix("-" + shortID)
        }
        // A nested viewer has its own document host. Do not save its query, which
        // can contain a temporary viewer credential.
        guard host.hasSuffix(".claudeusercontent.com") else { return false }
        let first = host.split(separator: ".").first.map(String.init) ?? ""
        return first == id.lowercased() || first == shortID.lowercased()
    }
    static func content(_ area: AXUIElement) throws -> Content {
        var lines: [String] = [], links: [[String: String]] = []
        let tree = try nodes(area)
        let values = tree.filter { string($0, kAXRoleAttribute) == kAXTextAreaRole }.map { string($0, kAXValueAttribute) }.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let uniqueValues = Array(Set(values))
        for node in tree {
            let role = string(node, kAXRoleAttribute)
            if role == kAXStaticTextRole {
                let value = string(node, kAXValueAttribute)
                let text = value.isEmpty ? string(node, kAXTitleAttribute) : value
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { lines.append(text) }
            }
            if role == "AXLink", let url = address(node), ["https", "http", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                guard !query.contains(where: { ["__frame_t", "__frame_v", "sk"].contains($0.name) }) else { continue }
                let label = string(node, kAXTitleAttribute)
                let row = ["text": label, "url": url.absoluteString]
                if !links.contains(row) { links.append(row) }
            }
        }
        // Some Electron editor frames expose the document through an AXTextArea
        // value instead of individual static text nodes.
        if uniqueValues.count == 1, let value = uniqueValues.first, value.trimmingCharacters(in: .whitespacesAndNewlines).count >= 20 {
            lines = [value]
        }
        return Content(text: lines.joined(separator: "\n"), links: links)
    }
    static func read(_ root: AXUIElement, id: String) throws -> Content? {
        let tree = try nodes(root), shortID = base58(id)
        // The document URL, not its title, establishes ownership. A title is not
        // unique and is never sufficient to select a report.
        let bound = tree.filter { node in
            string(node, kAXRoleAttribute) == "AXWebArea" && address(node).map { matches($0, id: id, shortID: shortID) } == true
        }
        var candidates: [Content] = []
        for area in bound {
            let descendants = try nodes(area).filter { string($0, kAXRoleAttribute) == "AXWebArea" }
            let nested = descendants.filter { !CFEqual($0, area) }
            let verified = nested.filter { node in address(node).map { matches($0, id: id, shortID: shortID) } == true }
            // Claude nests a route, a viewer, and a document editor. Only the
            // innermost frame with this ID owns the editor; outer frames also
            // contain their toolbar and must not produce a second candidate.
            if !verified.isEmpty { continue }
            // A nested frame can hold another document or the chat panel. Its
            // text length is not proof of ownership. Use an exact document URL,
            // or the sole nested editor beneath an exact document URL.
            let selected: [AXUIElement]
            if nested.count <= 1 {
                if let only = nested.first, let url = address(only), let host = url.host?.lowercased() {
                    let documentRoute = (host == "claude.ai" || host == "claude.com") && ["/artifact/", "/code/artifact/", "/code/frame/", "/epitaxy/artifact/"].contains { url.path.hasPrefix($0) }
                    if documentRoute || host.hasSuffix(".claudeusercontent.com") { throw Failure(message: "The report contains multiple document frames. Its current text could not be selected by document ID. No report was exported.") }
                }
                selected = nested.isEmpty ? [area] : nested
            }
            else { throw Failure(message: "The report contains multiple document frames. Its current text could not be selected by document ID. No report was exported.") }
            for node in selected {
                let value = try content(node)
                let text = value.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if text.count >= 20 && text.range(of: "^(Loading|Opening|Preparing)([. ]|…)*$", options: [.regularExpression, .caseInsensitive]) == nil && !candidates.contains(value) { candidates.append(value) }
            }
        }
        guard candidates.count <= 1 else { throw Failure(message: "The report contains multiple document frames. Its current text could not be selected by document ID. No report was exported.") }
        return candidates.first
    }
    static func export(id: String, org: String, title: String) throws -> Content {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        guard (session?["CGSSessionScreenIsLocked"] as? Bool) != true else { throw Failure(message: "Unlock the Mac and run the project capture again. No saved report was used.") }
        guard AXIsProcessTrusted() else { throw Failure(message: "Enable Claude Transplant Resume in System Settings > Privacy & Security > Accessibility, then run the project capture again.") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first else { throw Failure(message: "Open Claude in the source account, then run the project capture again.") }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 3)
        _ = AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        // Claude's installed route parser accepts this exact artifact route.
        guard let url = URL(string: "claude://claude.ai/code/artifact/" + id + "?org=" + org), NSWorkspace.shared.open(url) else { throw Failure(message: "Claude could not open the selected report. No saved report was used.") }
        app.activate(options: [])
        var previous: Content?
        for _ in 0..<60 {
            Thread.sleep(forTimeInterval: 0.25)
            if let current = try read(root, id: id) {
                if current == previous { return current }
                previous = current
            } else { previous = nil }
        }
        throw Failure(message: "The current report could not be read and checked by its document ID. Keep Claude open and unlocked, then run the project capture again.")
    }
    static func run(arguments: [String]) -> Int32 {
        func argument(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        do {
            guard let id = argument("--project-artifact-export"), validUUID(id), let org = argument("--organization"), validUUID(org), let account = argument("--account"), validUUID(account), let project = argument("--project"), project.range(of: "^chan_[A-Za-z0-9]+$", options: .regularExpression) != nil, let title = argument("--title"), title.utf8.count <= 8192 else { throw Failure(message: "Verified project and report identities are required.") }
            let value = try export(id: id, org: org, title: title)
            let output: [String: Any] = ["ok": true, "id": id, "organizationId": org, "accountId": account, "projectId": project, "documentIdVerified": true, "text": value.text, "links": value.links]
            let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data("\n".utf8))
            return 0
        } catch {
            let message = (error as? Failure)?.message ?? "The report export failed. No saved report was used."
            if let data = try? JSONSerialization.data(withJSONObject: ["ok": false, "error": message]) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data("\n".utf8)) }
            return 1
        }
    }
}
