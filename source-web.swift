import AppKit
import Foundation
import WebKit

// A source login has its own WebKit store. It never imports the Claude Desktop
// session, so signing out of Desktop does not sign out of this connection.
@MainActor
enum ProjectSourceWeb {
    struct Failure: Error {
        let code: String
        let message: String
    }

    static func runIfRequested(arguments: [String] = CommandLine.arguments) -> Int32? {
        let connect = arguments.contains("--project-source-connect")
        let credentials = arguments.contains("--project-source-credentials")
        guard connect || credentials else { return nil }
        func argument(_ flag: String) -> String? {
            guard let index = arguments.firstIndex(of: flag), index + 1 < arguments.count else { return nil }
            return arguments[index + 1]
        }
        guard connect != credentials,
              let accountText = argument("--account"), let account = UUID(uuidString: accountText),
              let orgText = argument("--org"), let org = UUID(uuidString: orgText),
              account != UUID(uuidString: "00000000-0000-0000-0000-000000000000") else {
            return write(["done": true, "ok": false, "code": "SOURCE_WEB_IDENTITY_REQUIRED", "error": "The source account and organization IDs are required."])
        }
        guard #available(macOS 14.0, *) else {
            return write(["done": true, "ok": false, "code": "SOURCE_WEB_MACOS_REQUIRED", "error": "The separate source login requires macOS 14 or later."])
        }
        let application = NSApplication.shared
        application.setActivationPolicy(connect ? .regular : .prohibited)
        let controller = Controller(account: account, org: org, connect: connect)
        controller.start()
        application.run()
        return write(controller.output ?? ["done": true, "ok": false, "code": "SOURCE_WEB_CANCELLED", "error": "The source connection was closed."])
    }

    static func write(_ result: [String: Any]) -> Int32 {
        guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { return 1 }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        return (result["ok"] as? Bool) == true ? 0 : 1
    }

    @available(macOS 14.0, *)
    final class Controller: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, URLSessionTaskDelegate {
        let account: UUID
        let org: UUID
        let connect: Bool
        let store: WKWebsiteDataStore
        let userAgent: String
        var output: [String: Any]?
        var window: NSWindow?
        var webView: WKWebView?
        var popupWindows: [NSWindow] = []
        var status: NSTextField?
        var button: NSButton?
        var timer: Timer?
        var deadline: Timer?
        var checking = false
        var connected = false
        var session: URLSession?

        init(account: UUID, org: UUID, connect: Bool) {
            self.account = account
            self.org = org
            self.connect = connect
            self.store = WKWebsiteDataStore(forIdentifier: account)
            let version = ProcessInfo.processInfo.operatingSystemVersion
            let safariMajor = version.majorVersion >= 26 ? version.majorVersion : version.majorVersion + 3
            self.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(safariMajor).0 Safari/605.1.15"
            super.init()
        }

        func start() {
            if connect {
                showLogin()
                timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
                    MainActor.assumeIsolated { self?.check() }
                }
            } else {
                deadline = Timer.scheduledTimer(withTimeInterval: 35, repeats: false) { [weak self] _ in
                    MainActor.assumeIsolated { self?.finish(error: Failure(code: "SOURCE_WEB_UNAVAILABLE", message: "The source login could not be checked. Open Connect source account and try again.")) }
                }
            }
            check()
        }

        func showLogin() {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = store
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.customUserAgent = userAgent
            view.navigationDelegate = self
            view.uiDelegate = self
            view.translatesAutoresizingMaskIntoConstraints = false
            let label = NSTextField(wrappingLabelWithString: "Sign in to the source account. This login stays separate from Claude Desktop. You can use the normal email login if an SSO provider does not allow this window.")
            label.translatesAutoresizingMaskIntoConstraints = false
            let checkButton = NSButton(title: "Check connection", target: self, action: #selector(checkPressed))
            checkButton.translatesAutoresizingMaskIntoConstraints = false
            let content = NSView()
            content.addSubview(label)
            content.addSubview(checkButton)
            content.addSubview(view)
            NSLayoutConstraint.activate([
                label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 18),
                label.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),
                label.trailingAnchor.constraint(equalTo: checkButton.leadingAnchor, constant: -18),
                checkButton.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
                checkButton.centerYAnchor.constraint(equalTo: label.centerYAnchor),
                view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
                view.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 14)
            ])
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1040, height: 780), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "Connect source account — Claude Transplant"
            window.contentView = content
            window.delegate = self
            window.isReleasedWhenClosed = false
            window.center()
            self.window = window
            self.webView = view
            self.status = label
            self.button = checkButton
            window.makeKeyAndOrderFront(nil)
            NSApplication.shared.activate(ignoringOtherApps: true)
            view.load(URLRequest(url: URL(string: "https://claude.ai/")!))
        }

        @objc func checkPressed() {
            if connected {
                check(finishWhenVerified: true)
            } else {
                check()
            }
        }

        func check(finishWhenVerified: Bool = false) {
            guard !checking, output == nil else { return }
            checking = true
            store.httpCookieStore.getAllCookies { [weak self] cookies in
                guard let self else { return }
                let sourceCookies = cookies.filter { cookie in
                    let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
                    return domain == "claude.ai" && (cookie.expiresDate.map { $0 > Date() } ?? true)
                }
                guard sourceCookies.contains(where: { $0.name == "sessionKey" && !$0.value.isEmpty }) else {
                    self.checked(.failure(Failure(code: "SOURCE_WEB_LOGIN_REQUIRED", message: "Sign in to the source account in this window, then select Check connection.")), finishWhenVerified: finishWhenVerified)
                    return
                }
                self.verify(cookies: sourceCookies) { result in
                    self.checked(result, finishWhenVerified: finishWhenVerified)
                }
            }
        }

        struct Identity {
            let email: String
            let cookies: [HTTPCookie]
        }

        func checked(_ result: Result<Identity, Failure>, finishWhenVerified: Bool) {
            checking = false
            session?.finishTasksAndInvalidate()
            session = nil
            guard output == nil else { return }
            switch result {
            case .success(let identity):
                if !connect || finishWhenVerified {
                    var value: [String: Any] = ["done": true, "ok": true, "account": account.uuidString.lowercased(), "org": org.uuidString.lowercased(), "email": identity.email]
                    if !connect {
                        value["userAgent"] = userAgent
                        value["cookies"] = identity.cookies.map { cookie -> [String: Any] in
                            var row: [String: Any] = ["name": cookie.name, "value": cookie.value, "domain": cookie.domain, "path": cookie.path, "secure": cookie.isSecure]
                            if let expires = cookie.expiresDate { row["expires"] = expires.timeIntervalSince1970 }
                            return row
                        }
                    }
                    finish(value)
                    return
                }
                connected = true
                timer?.invalidate()
                timer = nil
                webView?.isHidden = true
                for popup in popupWindows { popup.close() }
                popupWindows.removeAll()
                let name = identity.email.isEmpty ? "The source account" : identity.email
                status?.stringValue = "\(name) is connected. The source account and organization were checked. Project migration is ready for a later Claude Desktop account switch."
                button?.title = "Close"
            case .failure(let error):
                if connect {
                    connected = false
                    status?.stringValue = error.message
                    button?.title = "Check connection"
                    webView?.isHidden = false
                } else {
                    finish(error: error)
                }
            }
        }

        func verify(cookies: [HTTPCookie], completion: @escaping (Result<Identity, Failure>) -> Void) {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieStorage = nil
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            configuration.timeoutIntervalForRequest = 12
            configuration.timeoutIntervalForResource = 25
            let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
            self.session = session
            get("/api/account", cookies: cookies, session: session) { accountResult in
                switch accountResult {
                case .failure(let error): completion(.failure(error))
                case .success(let value):
                    guard let profile = value as? [String: Any], let uuid = profile["uuid"] as? String, UUID(uuidString: uuid) == self.account else {
                        completion(.failure(Failure(code: "SOURCE_WEB_ACCOUNT_MISMATCH", message: "This is a different account. Sign out in this window, then sign in to the source account.")))
                        return
                    }
                    let email = (profile["email_address"] as? String ?? profile["email"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    self.get("/api/organizations", cookies: cookies, session: session) { orgResult in
                        switch orgResult {
                        case .failure(let error): completion(.failure(error))
                        case .success(let value):
                            guard let organizations = value as? [[String: Any]], organizations.contains(where: { row in
                                (row["uuid"] as? String).flatMap(UUID.init(uuidString:)) == self.org
                            }) else {
                                completion(.failure(Failure(code: "SOURCE_WEB_ORG_MISMATCH", message: "The source organization is not available to this login. Use the source account and organization.")))
                                return
                            }
                            completion(.success(Identity(email: String(email.prefix(320)), cookies: cookies)))
                        }
                    }
                }
            }
        }

        func get(_ path: String, cookies: [HTTPCookie], session: URLSession, completion: @escaping (Result<Any, Failure>) -> Void) {
            let url = URL(string: "https://claude.ai" + path)!
            let applicable = cookies.filter { url.path.hasPrefix($0.path) }
            let fields = HTTPCookie.requestHeaderFields(with: applicable)
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.httpShouldHandleCookies = false
            request.allHTTPHeaderFields = fields
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
            request.setValue("https://claude.ai", forHTTPHeaderField: "Origin")
            request.setValue("https://claude.ai/", forHTTPHeaderField: "Referer")
            session.dataTask(with: request) { data, response, error in
                DispatchQueue.main.async {
                    guard self.output == nil else { return }
                    guard error == nil, let response = response as? HTTPURLResponse, response.url == url, response.statusCode == 200,
                          let data, data.count <= 2 * 1024 * 1024, let value = try? JSONSerialization.jsonObject(with: data) else {
                        completion(.failure(Failure(code: "SOURCE_WEB_UNAVAILABLE", message: "The source login could not be checked. Finish the login in this window, then select Check connection.")))
                        return
                    }
                    completion(.success(value))
                }
            }.resume()
        }

        nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { check() }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let scheme = navigationAction.request.url?.scheme?.lowercased()
            decisionHandler(scheme == "https" || scheme == "about" ? .allow : .cancel)
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard navigationAction.request.url?.scheme?.lowercased() == "https" else { return nil }
            configuration.websiteDataStore = store
            let view = WKWebView(frame: .zero, configuration: configuration)
            view.customUserAgent = userAgent
            view.navigationDelegate = self
            view.uiDelegate = self
            let popup = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 780), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            popup.title = "Source account sign in"
            popup.contentView = view
            popup.isReleasedWhenClosed = false
            popup.center()
            popup.makeKeyAndOrderFront(nil)
            popupWindows.append(popup)
            return view
        }

        func webViewDidClose(_ webView: WKWebView) {
            popupWindows.first(where: { $0.contentView === webView })?.close()
        }

        func windowShouldClose(_ sender: NSWindow) -> Bool {
            finish(error: Failure(code: "SOURCE_WEB_CANCELLED", message: "The source connection was closed. Select Connect source account to continue."))
            return true
        }

        func finish(error: Failure) { finish(["done": true, "ok": false, "code": error.code, "error": error.message]) }

        func finish(_ result: [String: Any]) {
            guard output == nil else { return }
            output = result
            timer?.invalidate()
            deadline?.invalidate()
            session?.invalidateAndCancel()
            window?.orderOut(nil)
            for popup in popupWindows { popup.orderOut(nil) }
            NSApplication.shared.stop(nil)
            if let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
                NSApplication.shared.postEvent(event, atStart: false)
            }
        }
    }
}
