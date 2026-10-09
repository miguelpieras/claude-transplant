import SwiftUI
import ApplicationServices

struct LocalAccount: Decodable {
    let account: String
    let org: String
    let label: String?
}
struct ResumeItem: Decodable {
    let recordId: String
    let cliSessionId: String
    let title: String
    let reason: String
}
struct LocalPlan: Decodable {
    let from: LocalAccount
    let to: LocalAccount
    let count: Int
    let moving: Bool
    let recovery: Bool?
    let token: String
    let resume: [ResumeItem]
}
struct LocalSetup: Decodable {
    let setup: Bool
}
struct LocalResult: Decodable {
    let done: Bool?
    let ok: Bool?
    let moved: Int?
    let resume: [ResumeItem]?
    let target: LocalAccount?
    let text: String?
}
struct ResumeStatus: Decodable {
    struct Row: Decodable {
        let recordId: String
        let title: String
        let activity: Bool
        let error: String?
        let waiting: String?
    }
    let rows: [Row]
}

extension Model {
    func refreshWorkflow() {
        guard !flowRefreshing, !flowBusy, !flowChoosingSource else { return }
        flowRefreshing = true
        var output = ""
        run(["local-plan", "--json"], line: { output += $0 }) { [weak self] status, error in
            guard let self else { return }
            flowRefreshing = false
            if status == 0, let data = output.data(using: .utf8), let plan = try? JSONDecoder().decode(LocalPlan.self, from: data) {
                flowPlan = plan
                flowNeedsSource = false
                flowError = ""
            } else if status == 0, let data = output.data(using: .utf8), (try? JSONDecoder().decode(LocalSetup.self, from: data))?.setup == true {
                flowPlan = nil
                flowNeedsSource = true
                flowError = ""
            } else {
                flowPlan = nil
                flowError = error.replacingOccurrences(of: "claude-transplant-resume: ", with: "")
            }
        }
    }

    func chooseWorkflowSource() {
        guard !flowSource.isEmpty, !flowBusy else { return }
        flowBusy = true
        flowActionError = ""
        run(["local-source", "--source", flowSource, "--json"], line: { _ in }) { [weak self] status, error in
            guard let self else { return }
            flowBusy = false
            if status != 0 { flowActionError = error; return }
            flowChoosingSource = false
            flowNeedsSource = false
            note = ""
            lines = []
            refreshWorkflow()
        }
    }

    func startWorkflow() {
        guard let plan = flowPlan, !flowBusy else { return }
        flowActionError = ""
        if flowResume && !plan.resume.isEmpty && !AXIsProcessTrusted() {
            let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(prompt)
            flowActionError = "Enable Claude Transplant Resume in System Settings → Privacy & Security → Accessibility, then click again."
            return
        }
        flowBusy = true
        flowAlreadyRunning = []
        running = true
        lines = []
        badge = ""
        note = plan.moving ? "Checking the destination" : "Checking stopped conversations"
        var result: LocalResult?
        var args = ["local-move", "--restart-approved", plan.token, "--json"]
        if !flowResume { args.append("--no-resume") }
        run(args, line: { [weak self] line in
            guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(LocalResult.self, from: data) else { return }
            if let text = event.text { self?.note = text }
            if event.done == true { result = event }
        }) { [weak self] status, error in
            guard let self else { return }
            guard status == 0, let result, result.ok == true, let target = result.target else {
                flowBusy = false; running = false
                flowActionError = error.isEmpty ? "The move did not finish. Refresh before retrying." : error
                refreshWorkflow()
                return
            }
            let items = result.resume ?? []
            if items.isEmpty {
                note = result.moved ?? 0 > 0 ? "Moved \(result.moved ?? 0) records. \(flowResume ? "No recent interrupted conversations need a restart." : "Automatic resume is off.")" : "Your conversations are on this plan. No recent interrupted conversations need a restart."
                flowBusy = false; running = false; refreshWorkflow()
                return
            }
            note = "Resuming \(items.count) conversations"
            self.resumeWorkflow(items, target: target, index: 0, moved: result.moved ?? 0)
        }
    }

    private func resumeWorkflow(_ items: [ResumeItem], target: LocalAccount, index: Int, moved: Int, retry: Int = 0) {
        guard index < items.count else { verifyWorkflow(attempt: 0, moved: moved); return }
        var identity = ""
        run(["local-identity", "--json"], line: { identity += $0 }) { [weak self] status, error in
            guard let self else { return }
            let current = identity.data(using: .utf8).flatMap { try? JSONDecoder().decode(LocalAccount.self, from: $0) }
            if current == nil && retry < 15 {
                note = "Waiting for Claude to open"
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.resumeWorkflow(items, target: target, index: index, moved: moved, retry: retry + 1) }
                return
            }
            guard status == 0, let current, current.account == target.account, current.org == target.org else {
                flowActionError = "The selected Claude account changed or could not be checked. Resume stopped before sending another message."
                flowBusy = false; running = false; return
            }
            note = "Resuming \(index + 1) of \(items.count): \(items[index].title)"
            DispatchQueue.global(qos: .userInitiated).async {
                let outcome = ClaudeResume.resume(items[index])
                DispatchQueue.main.async {
                    if outcome.ok && outcome.message == "already running" { self.flowAlreadyRunning.insert(items[index].recordId) }
                    self.lines.append((outcome.ok ? "resume" : "attention", items[index].title + " | " + outcome.message))
                    self.resumeWorkflow(items, target: target, index: index + 1, moved: moved)
                }
            }
        }
    }

    private func verifyWorkflow(attempt: Int, moved: Int) {
        var text = ""
        run(["local-status", "--json"], line: { text += $0 }) { [weak self] status, error in
            guard let self else { return }
            guard status == 0, let data = text.data(using: .utf8), let result = try? JSONDecoder().decode(ResumeStatus.self, from: data) else {
                flowBusy = false; running = false; flowActionError = "Resume verification failed: " + error; return
            }
            let active = result.rows.filter { ($0.activity || self.flowAlreadyRunning.contains($0.recordId)) && $0.error == nil && ($0.waiting ?? "").isEmpty }.count
            let waiting = result.rows.filter { $0.error != nil || !($0.waiting ?? "").isEmpty }.count
            let pending = result.rows.count - active - waiting
            let pendingText = pending == 0 ? "" : attempt < 18 ? " · checking \(pending)" : " · \(pending) unconfirmed"
            note = "\(moved > 0 ? "Moved \(moved) records. " : "")\(active) resumed\(waiting > 0 ? " · \(waiting) need attention" : "")\(pendingText)"
            if pending > 0 && attempt < 18 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { self.verifyWorkflow(attempt: attempt + 1, moved: moved) }
                return
            }
            for row in result.rows where row.error != nil || (!row.activity && !flowAlreadyRunning.contains(row.recordId)) || !(row.waiting ?? "").isEmpty {
                let reason = row.error ?? ((row.waiting ?? "").isEmpty ? "No new activity confirmed" : row.waiting!)
                lines.append(("attention", row.title + " | " + reason))
            }
            flowBusy = false; running = false
            detailsExpanded = lines.contains { $0.0 == "attention" }
            refreshWorkflow()
        }
    }
}

enum ClaudeResume {
    static let message = "Continue the existing task from where it stopped. Check the result of any interrupted command or pending check before running it again. Keep the existing scope and instructions."
    static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    static func text(_ element: AXUIElement, _ name: String) -> String { attribute(element,name) as? String ?? "" }
    static func label(_ element: AXUIElement) -> String {
        let title = text(element,kAXTitleAttribute)
        return title.isEmpty ? text(element,kAXDescriptionAttribute) : title
    }
    static func elements(_ root: AXUIElement) -> [AXUIElement] {
        var stack = [root], found: [AXUIElement] = []
        while let element = stack.popLast(), found.count < 20000 {
            found.append(element)
            stack.append(contentsOf: (attribute(element,kAXChildrenAttribute) as? [AXUIElement] ?? []).reversed())
        }
        return found
    }
    static func isSelected(_ tree: [AXUIElement], item: ResumeItem) -> Bool {
        tree.contains { element in
            let value = attribute(element,kAXURLAttribute)
            let address = (value as? URL)?.absoluteString ?? (value as? String) ?? ""
            return URL(string: address)?.lastPathComponent == item.recordId
        }
    }
    static func conversationRows<Node>(_ nodes: [Node], title: String, label: (Node) -> String, parent: (Node) -> Node?, buttons: (Node) -> [Node]) -> [Node] {
        guard !title.isEmpty else { return [] }
        let menuLabel = "More options for " + title
        // Row labels include status and suggestion provenance. The menu retains the exact title.
        return nodes.filter { label($0) == menuLabel }.flatMap { menu -> [Node] in
            var ancestor = parent(menu)
            // Electron can wrap the menu separately from the conversation button.
            for _ in 0..<8 {
                guard let row = ancestor else { break }
                let candidates = buttons(row).filter { label($0) != menuLabel }
                if !candidates.isEmpty { return candidates }
                ancestor = parent(row)
            }
            return []
        }
    }
    static func conversationMatches(_ tree: [AXUIElement], item: ResumeItem) -> [AXUIElement] {
        guard let sidebar = tree.first(where: { label($0) == "Sidebar" }) else { return [] }
        // Chat messages can contain buttons with another conversation's title.
        return conversationRows(elements(sidebar), title: item.title, label: label, parent: { element in
            guard let value = attribute(element,kAXParentAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
            let parent = value as! AXUIElement
            return CFEqual(parent,sidebar) ? nil : parent
        }, buttons: { elements($0).filter { text($0,kAXRoleAttribute) == kAXButtonRole } })
    }
    static func press(_ element: AXUIElement) -> Bool { AXUIElementPerformAction(element,kAXPressAction as CFString) == .success }
    static func resume(_ item: ResumeItem) -> (ok: Bool, message: String) {
        guard AXIsProcessTrusted() else { return (false,"macOS Accessibility access is not active for this app") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first else { return (false,"Claude is not open") }
        app.activate(options: [])
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root,3)
        // Electron does not expose renderer controls immediately after a cold start.
        _ = AXUIElementSetAttributeValue(root,"AXManualAccessibility" as CFString,kCFBooleanTrue)
        var tree: [AXUIElement] = []
        for _ in 0..<30 {
            tree = elements(root)
            if !conversationMatches(tree,item:item).isEmpty { break }
            Thread.sleep(forTimeInterval:0.5)
        }
        if let code = tree.first(where: { text($0,kAXRoleAttribute) == kAXRadioButtonRole && label($0) == "Code" }), (attribute(code,kAXValueAttribute) as? Int) == 0 {
            guard press(code) else { return (false,"Could not open the Code tab") }
            Thread.sleep(forTimeInterval:0.5)
            tree = elements(root)
        }
        let matches = conversationMatches(tree,item:item)
        // Several sidebar groups can hold the same title. Never choose one by order.
        guard matches.count == 1, let row = matches.first else { return (false,"Open this conversation manually; its title is missing or not unique") }
        guard press(row) else { return (false,"Could not open the conversation") }
        for _ in 0..<40 {
            Thread.sleep(forTimeInterval:0.25)
            tree = elements(root)
            if isSelected(tree,item:item) && tree.contains(where:{text($0,kAXRoleAttribute)==kAXTextAreaRole && text($0,kAXDescriptionAttribute)=="Prompt"}) { break }
        }
        guard isSelected(tree, item: item) else { return (false,"The selected conversation could not be checked") }
        if tree.contains(where:{text($0,kAXRoleAttribute)==kAXButtonRole && label($0)=="Stop"}) { return (true,"already running") }
        guard let prompt = tree.first(where:{text($0,kAXRoleAttribute)==kAXTextAreaRole && text($0,kAXDescriptionAttribute)=="Prompt"}) else { return (false,"Claude's prompt control is unavailable") }
        guard text(prompt,kAXValueAttribute).trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else { return (false,"An unsent draft was left unchanged") }
        guard AXUIElementSetAttributeValue(prompt,kAXValueAttribute as CFString,message as CFString) == .success else { return (false,"Could not enter the continuation request") }
        Thread.sleep(forTimeInterval:0.3)
        tree = elements(root)
        guard isSelected(tree, item: item) else { return (false,"The selected conversation changed; no message was sent") }
        guard text(prompt,kAXValueAttribute) == message, let send = tree.first(where:{text($0,kAXRoleAttribute)==kAXButtonRole && label($0)=="Send"}), (attribute(send,kAXEnabledAttribute) as? Bool) == true else { return (false,"The continuation request is in the draft; press Send manually") }
        guard press(send) else { return (false,"The request remains in the draft") }
        return (true,"request sent; checking activity")
    }
}

struct WorkflowPanel: View {
    @EnvironmentObject var model: Model
    var body: some View {
        VStack(alignment:.leading,spacing:10) {
            if model.flowNeedsSource {
                Text("Choose the account that holds your conversations.").font(.callout)
                Picker("Source", selection: $model.flowSource) {
                    Text("Select an account and plan").tag("")
                    ForEach(model.accounts.filter { ($0.sessions ?? 0) > 0 }) { account in
                        Text("\(account.name) · \(account.plan) · \(account.sessions ?? 0) records").tag(account.id)
                    }
                }.disabled(model.flowBusy)
                Button("Use these conversations") { model.chooseWorkflowSource() }
                    .buttonStyle(.borderedProminent).disabled(model.flowSource.isEmpty || model.flowBusy)
                if model.flowChoosingSource {
                    Button("Cancel") { model.flowChoosingSource = false; model.flowNeedsSource = false; model.refreshWorkflow() }
                        .disabled(model.flowBusy)
                }
            } else if let plan = model.flowPlan {
                if plan.moving {
                    Text("FROM").font(.caption).foregroundStyle(.secondary)
                    Text(plan.from.label ?? plan.from.account).font(.callout.weight(.semibold))
                }
                Text(plan.moving ? "TO" : "CURRENT PLAN").font(.caption).foregroundStyle(.secondary)
                Text(plan.to.label ?? plan.to.account).font(.callout.weight(.semibold))
                Text("\(plan.count) records · \(plan.resume.count) recent resume candidates").font(.caption).foregroundStyle(.secondary)
                if !plan.moving { Text("Sign into another Personal plan in Claude to move there.").font(.caption).foregroundStyle(.secondary) }
                Toggle("Resume stopped conversations", isOn: $model.flowResume).font(.caption).disabled(model.flowBusy)
                if model.flowResume && !plan.resume.isEmpty { Text("Sends a Continue message to unfinished conversations active in the last 24 hours.").font(.caption).foregroundStyle(.secondary) }
                Button(plan.recovery == true ? "Recover move" : plan.moving ? (model.flowResume ? "Move and resume" : "Move") : "Resume stopped") { model.startWorkflow() }
                    .buttonStyle(.borderedProminent).disabled(model.flowBusy || (!plan.moving && (plan.resume.isEmpty || !model.flowResume)))
            } else if model.flowError.isEmpty {
                ProgressView("Reading Claude accounts")
            }
            if !model.flowError.isEmpty { Text(model.flowError).font(.caption).foregroundStyle(.orange) }
            if !model.flowActionError.isEmpty {
                Text(model.flowActionError).font(.caption).foregroundStyle(.orange)
                if model.flowActionError.contains("Accessibility") {
                    Button("Open app folder") { NSWorkspace.shared.selectFile(Bundle.main.bundlePath, inFileViewerRootedAtPath: "") }
                }
            }
            if model.flowBusy { ProgressView().controlSize(.small) }
            DisclosureGroup("Accounts") {
                ForEach(model.accounts) { account in
                    HStack {
                        VStack(alignment:.leading) {
                            Text(account.name).font(.caption.weight(.semibold))
                            Text(account.plan).font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if account.active == true { Text("active").font(.caption2).foregroundStyle(.green) }
                        Text("\(account.sessions ?? 0)").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                if !model.flowNeedsSource {
                    Button("Choose a different source") { model.flowChoosingSource = true; model.flowNeedsSource = true; model.flowSource = "" }
                        .disabled(model.flowBusy || model.flowPlan?.recovery == true)
                }
            }.font(.caption)
            HStack { Spacer();Button("Quit") { NSApplication.shared.terminate(nil) }.buttonStyle(.plain).foregroundStyle(.secondary) }
        }
    }
}

// A normal control window also makes the app accessible when opened from Finder.
@MainActor
final class ControlPanelDelegate: NSObject, NSApplicationDelegate {
    static var model: Model?
    private var window: NSWindow?

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showPanel()
        return false
    }

    func showPanel() {
        guard let model = Self.model else { return }
        if window == nil {
            let view = Panel().environmentObject(model).environment(\.colorScheme,.dark)
            let host = NSHostingController(rootView:view)
            let created = NSWindow(contentViewController:host)
            created.title = "Claude Transplant Resume"
            created.styleMask = [.titled,.closable,.miniaturizable]
            created.isReleasedWhenClosed = false
            created.center()
            window = created
        }
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps:true)
    }
}
