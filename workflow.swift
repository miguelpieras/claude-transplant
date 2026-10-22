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
    let limitResumeCount: Int?
}
struct LocalSetup: Decodable {
    let setup: Bool
}
struct ProjectPlan: Decodable {
    struct Project: Decodable, Identifiable {
        let id: String
        let name: String
    }
    let selected: Bool
    let count: Int?
    let title: String?
    let projectId: String?
    let source: LocalAccount?
    let current: LocalAccount?
    let canStage: Bool
    let canMove: Bool
    let phase: String?
    let ready: Bool?
    let localCount: Int?
    let preparedAt: String?
    let note: String?
    let projects: [Project]
}
struct LocalResult: Decodable {
    let done: Bool?
    let ok: Bool?
    let moved: Int?
    let resume: [ResumeItem]?
    let target: LocalAccount?
    let text: String?
    let paused: Bool?
    let accepted: Bool?
    let count: Int?
    let ready: Bool?
    let localCount: Int?
    let preparedAt: String?
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
        guard !flowRefreshing, !projectRefreshing, !flowBusy else { return }
        if flowChoosingSource { refreshProjectWorkflow(); return }
        flowRefreshing = true
        flowError = ""
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
                flowError = error.isEmpty ? "Could not verify your Claude account. Keep Claude open and try again shortly." : error.replacingOccurrences(of: "claude-transplant-resume: ", with: "")
            }
            refreshProjectWorkflow()
        }
    }

    func refreshProjectWorkflow(force: Bool = false) {
        guard !projectRefreshing, !flowBusy else { return }
        let active = accounts.filter { $0.active == true }.map(\.id).joined(separator: ",")
        let source = flowPlan.map { "\($0.from.account)/\($0.from.org)" } ?? ""
        let identity = "\(active):\(source)"
        if !force, identity == projectRefreshIdentity, let checked = projectRefreshedAt, Date().timeIntervalSince(checked) < 60 { return }
        projectRefreshing = true
        projectRefreshIdentity = identity
        var output = ""
        run(["project-status", "--json"], line: { output += $0 }) { [weak self] status, error in
            guard let self else { return }
            projectRefreshing = false
            projectRefreshedAt = Date()
            if status == 0, let data = output.data(using: .utf8), let plan = try? JSONDecoder().decode(ProjectPlan.self, from: data) {
                projectPlan = plan
                projectError = ""
            } else {
                projectPlan = nil
                projectError = error.isEmpty ? "Could not check the projects. Refresh before you move." : error.replacingOccurrences(of: "claude-transplant-resume: ", with: "")
            }
        }
    }

    private func projectSummary(count: Int, accepted: Bool) -> String {
        let projects = count == 1 ? "1 project" : "\(count) projects"
        return accepted ? "Moved \(projects). Continuation requests accepted." : "Moved \(projects). The projects are paused."
    }

    func prepareWorkflow() {
        guard let plan = flowPlan, !plan.moving, !flowBusy, !flowChecking else { return }
        guard projectError.isEmpty, let project = projectPlan, project.canStage,
              let current = project.current, current.account == plan.to.account, current.org == plan.to.org else {
            flowActionError = projectError.isEmpty ? "The source account could not be checked. Refresh before you copy it." : projectError
            refreshProjectWorkflow(force: true)
            return
        }
        flowBusy = true
        running = true
        flowActionError = ""
        lines = []
        note = "Saving projects and conversations on this Mac"
        var result: LocalResult?
        run(["project-stage-all", "--json"], line: { [weak self] line in
            guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(LocalResult.self, from: data) else { return }
            if let text = event.text { self?.note = text }
            if event.done == true { result = event }
        }) { [weak self] status, error in
            guard let self else { return }
            flowBusy = false
            running = false
            if status == 0, result?.ok == true, result?.ready == true {
                note = "Ready to switch accounts. Sign out of Claude, then sign into the new Personal plan."
                lines.append(("saved", "Saved \(result?.localCount ?? plan.count) conversations and \(result?.count ?? project.count ?? 0) projects on this Mac."))
            } else {
                flowActionError = error.isEmpty ? "The local copy is incomplete. Keep the source account signed in and click Transplant again." : error
            }
            projectRefreshedAt = nil
            refreshWorkflow()
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

    func startWorkflow(limitsOnly: Bool = false) {
        guard let plan = flowPlan, !flowBusy, !flowChecking else { return }
        if limitsOnly && (plan.moving || plan.recovery == true || (plan.limitResumeCount ?? 0) == 0) { return }
        flowActionError = ""
        if (limitsOnly || flowResume) && !plan.resume.isEmpty && !AXIsProcessTrusted() {
            let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(prompt)
            flowActionError = "Enable Claude Transplant Resume in System Settings → Privacy & Security → Accessibility, then click again."
            return
        }
        if plan.moving && !limitsOnly {
            guard projectError.isEmpty, let project = projectPlan else {
                flowActionError = projectError.isEmpty ? "The projects could not be checked. Refresh before you move." : projectError
                refreshProjectWorkflow(force: true)
                return
            }
            guard let current = project.current, current.account == plan.to.account, current.org == plan.to.org else {
                flowActionError = "The project source or destination changed. Refresh before you move."
                return
            }
            guard project.ready == true, project.canMove else {
                flowActionError = "Return to the source account and click Transplant before you switch accounts."
                return
            }
            flowBusy = true
            running = true
            lines = []
            note = "Restoring the saved projects"
            var result: LocalResult?
            var projectArgs = ["project-move", "--json"]
            if !flowResume { projectArgs.append("--no-resume") }
            run(projectArgs, line: { [weak self] line in
                guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(LocalResult.self, from: data) else { return }
                if let text = event.text { self?.note = text }
                if event.done == true { result = event }
            }) { [weak self] status, error in
                guard let self else { return }
                guard status == 0, result?.ok == true else {
                    flowBusy = false
                    running = false
                    flowActionError = error.isEmpty ? "The project transfer did not finish. Local conversations were left in place." : error
                    projectRefreshedAt = nil
                    refreshWorkflow()
                    return
                }
                projectRefreshedAt = nil
                startLocalWorkflow(plan, limitsOnly: limitsOnly, projectCount: result?.count ?? project.count ?? project.projects.count, projectResumed: result?.accepted == true)
            }
            return
        }
        startLocalWorkflow(plan, limitsOnly: limitsOnly)
    }

    private func startLocalWorkflow(_ plan: LocalPlan, limitsOnly: Bool, projectCount: Int = 0, projectResumed: Bool = false) {
        flowBusy = true
        flowAlreadyRunning = []
        running = true
        lines = []
        if projectCount > 0 { lines.append(("projects", projectSummary(count: projectCount, accepted: projectResumed))) }
        badge = ""
        note = limitsOnly ? "Checking usage-limit errors" : plan.moving ? "Checking the destination" : "Checking stopped conversations"
        var result: LocalResult?
        var args = ["local-move", "--restart-approved", plan.token, "--json"]
        if limitsOnly { args.append("--limits-only") }
        else if !flowResume { args.append("--no-resume") }
        run(args, line: { [weak self] line in
            guard let data = line.data(using: .utf8), let event = try? JSONDecoder().decode(LocalResult.self, from: data) else { return }
            if let text = event.text { self?.note = text }
            if event.done == true { result = event }
        }) { [weak self] status, error in
            guard let self else { return }
            guard status == 0, let result, result.ok == true, let target = result.target else {
                flowBusy = false; running = false
                flowActionError = error.isEmpty ? "The operation did not finish. Refresh before retrying." : error
                refreshWorkflow()
                return
            }
            let items = result.resume ?? []
            if items.isEmpty {
                note = result.moved ?? 0 > 0 ? "Moved \(result.moved ?? 0) records. \(flowResume ? "No recent interrupted conversations need a restart." : "Automatic resume is off.")" : "Your conversations are on this plan. No recent interrupted conversations need a restart."
                if limitsOnly { note = "No recent conversations with a usage-limit error need a restart." }
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
    // The session link opens one conversation even when several share a title.
    static func link(_ recordId: String) -> URL? {
        guard recordId.range(of: "^local_[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$", options: [.regularExpression,.caseInsensitive]) != nil else { return nil }
        return URL(string: "claude://claude.ai/epitaxy/" + recordId)
    }
    static func press(_ element: AXUIElement) -> Bool { AXUIElementPerformAction(element,kAXPressAction as CFString) == .success }
    static func resume(_ item: ResumeItem) -> (ok: Bool, message: String) {
        guard AXIsProcessTrusted() else { return (false,"macOS Accessibility access is not active for this app") }
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop").first else { return (false,"Claude is not open") }
        guard let url = link(item.recordId) else { return (false,"Could not open the conversation") }
        app.activate(options: [])
        let root = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(root,3)
        // Electron does not expose renderer controls immediately after a cold start.
        _ = AXUIElementSetAttributeValue(root,"AXManualAccessibility" as CFString,kCFBooleanTrue)
        guard NSWorkspace.shared.open(url) else { return (false,"Could not open the conversation") }
        var tree: [AXUIElement] = []
        for _ in 0..<60 {
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
            if model.flowChecking { ProgressView("Checking account…").controlSize(.small) }
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
                HStack(spacing: 4) {
                    Text("\(model.projectPlan?.ready == true ? model.projectPlan?.localCount ?? plan.count : plan.count) conversations")
                    Text("·")
                    if let count = model.projectPlan?.count {
                        Text(count == 1 ? "1 project" : "\(count) projects")
                    } else {
                        Text("All projects included")
                    }
                }.font(.caption).foregroundStyle(.secondary)
                if model.flowBusy && !plan.moving {
                    Text(model.note).font(.caption).foregroundStyle(.secondary)
                } else if plan.moving && model.projectPlan?.ready == true && model.projectPlan?.canMove != true {
                    Text(model.projectPlan?.note ?? "Sign into the saved destination account to finish this move.").font(.caption).foregroundStyle(.orange)
                } else if model.projectPlan?.ready == true {
                    Text(plan.moving ? "Saved copy ready" : "Ready to switch accounts").font(.callout.weight(.semibold))
                    Text(plan.moving ? "Restore the saved projects and conversations with this account." : "Sign out of Claude, then sign into the new Personal plan.").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(plan.moving ? "Return to the source account and click Transplant before you switch accounts." : "Click Transplant to save your projects and conversations on this Mac. Wait for Ready to switch accounts before you sign out.").font(.caption).foregroundStyle(.secondary)
                }
                if plan.moving {
                    Toggle("Resume stopped conversations", isOn: $model.flowResume).font(.caption).disabled(model.flowBusy)
                    if model.flowResume && !plan.resume.isEmpty { Text("Sends a Continue message to unfinished conversations active in the last 24 hours.").font(.caption).foregroundStyle(.secondary) }
                    Button(plan.recovery == true ? "Recover move" : model.flowResume ? "Move and resume" : "Move") { model.startWorkflow() }
                        .buttonStyle(.borderedProminent).disabled(model.flowBusy || model.flowChecking || model.projectPlan?.ready != true || model.projectPlan?.canMove != true)
                } else {
                    Button("Transplant") { model.prepareWorkflow() }
                        .buttonStyle(.borderedProminent).disabled(model.flowBusy || model.flowChecking || model.projectPlan?.canStage != true)
                }
                if !plan.moving && plan.recovery != true && model.projectPlan?.ready != true {
                    Button("Resume limit-stopped (\(plan.limitResumeCount ?? 0))") { model.startWorkflow(limitsOnly: true) }
                        .disabled(model.flowBusy || model.flowChecking || (plan.limitResumeCount ?? 0) == 0)
                    Text("Retries usage-limit errors from the last 24 hours on this account.").font(.caption).foregroundStyle(.secondary)
                }
            } else if model.flowError.isEmpty && !model.flowChecking {
                ProgressView("Checking account…").controlSize(.small)
            }
            Divider()
            if !model.flowChecking && !model.projectError.isEmpty { Text(model.projectError).font(.caption).foregroundStyle(.orange) }
            if !model.flowChecking && !model.flowError.isEmpty { Text(model.flowError).font(.caption).foregroundStyle(.orange) }
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
