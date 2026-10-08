// ホストの窓。127.0.0.1 のプロキシを開き、main frame の同じオリジンだけに plyRemote を渡す（ADR 0174）。
import UIKit
import WebKit
import PleiadRemote
final class HostViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate, UIDocumentPickerDelegate {
    private static let bridgeName = "plyRemoteBridge"
    private static let worker = DispatchQueue(label: "pleiad-host")
    private static let darkPaper = UIColor(red: 0x1b / 255.0, green: 0x1c / 255.0, blue: 0x23 / 255.0, alpha: 1)

    let hostId: String
    var onLeave: (() -> Void)?
    private let device: RemoteDevice
    private var proxy: DeviceProxy?
    private var web: WKWebView?
    private var origin = ""
    private var receiver = ""
    private var hello = false
    private var popup: WKWebView?
    private var sheet: UIView?
    private var sheetTitle: UILabel?
    private var titleWatch: NSKeyValueObservation?
    private var downloads: [ObjectIdentifier: URL] = [:]
    private var downloadTasks: [ObjectIdentifier: WKDownload] = [:]
    private var exportDirectory: URL?
    private let topBand = UIView()
    private let content = UIView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private var errorPanel: UIView?
    private var dark = false
    private var statusToken: Int?
    private var left = false

    init(hostId: String, device: RemoteDevice) {
        self.hostId = hostId
        self.device = device
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { dark ? .lightContent : .darkContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        ResumeStore.remember(hostId)
        let isDark = traitCollection.userInterfaceStyle == .dark
        let paper = isDark ? HostViewController.darkPaper : .white
        applyBars(isDark, paper, paper)
        for v in [topBand, content] {
            v.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(v)
        }
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        content.addSubview(spinner)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            topBand.topAnchor.constraint(equalTo: view.topAnchor),
            topBand.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topBand.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            topBand.bottomAnchor.constraint(equalTo: safe.topAnchor),
            content.topAnchor.constraint(equalTo: safe.topAnchor),
            content.leadingAnchor.constraint(equalTo: safe.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: safe.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            spinner.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        let id = hostId
        statusToken = device.onStatus { [weak self] hid, s in
            guard hid == id else { return }
            DispatchQueue.main.async { self?.pushStatus(s) }
        }
        HostViewController.worker.async { [weak self, device] in
            do {
                let px = try device.open(id)
                DispatchQueue.main.async { if let self, !self.left { self.showHost(px) } }
            } catch {
                NSLog("Pleiad: open host: %@", String(describing: error))
                DispatchQueue.main.async { self?.showError(ShellTexts.hostOpenFailed) }
            }
        }
    }
    func leave(forget: Bool) {
        if left { return }
        left = true
        if forget { ResumeStore.forget(hostId) }
        teardown()
        let id = hostId
        HostViewController.worker.async { [device] in device.close(id) }
        onLeave?()
    }

    private func teardown() {
        if let statusToken { device.offStatus(statusToken) }
        statusToken = nil
        closePopup()
        for task in downloadTasks.values {
            task.delegate = nil
            task.cancel { _ in }
        }
        downloadTasks.removeAll()
        for file in downloads.values { removeDownload(file) }
        downloads.removeAll()
        clearExport()
        if let w = web {
            w.configuration.userContentController.removeScriptMessageHandler(forName: HostViewController.bridgeName)
            w.stopLoading()
        }
    }

    deinit {
        if let statusToken { device.offStatus(statusToken) }
    }

    private func showError(_ text: String) {
        guard !left else { return }
        errorPanel?.removeFromSuperview()
        spinner.stopAnimating()
        let label = UILabel()
        label.text = text
        label.numberOfLines = 0
        label.textColor = dark ? .white : .label
        let back = UIButton(configuration: .plain(), primaryAction: UIAction(title: ShellTexts.backToHosts) { [weak self] _ in
            self?.leave(forget: true)
        })
        let panel = UIStackView(arrangedSubviews: [label, back])
        panel.axis = .vertical
        panel.spacing = 12
        panel.backgroundColor = view.backgroundColor
        panel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(panel)
        errorPanel = panel
        NSLayoutConstraint.activate([
            panel.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            panel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            panel.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
        ])
    }

    private func showHost(_ px: DeviceProxy) {
        proxy = px
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = .all
        cfg.userContentController.add(WeakMessageHandler(self), name: HostViewController.bridgeName)
        let w = WKWebView(frame: .zero, configuration: cfg)
        w.navigationDelegate = self
        w.uiDelegate = self
        w.isOpaque = false
        w.backgroundColor = view.backgroundColor
        w.scrollView.contentInsetAdjustmentBehavior = .never
        w.scrollView.showsVerticalScrollIndicator = false
        w.scrollView.showsHorizontalScrollIndicator = false
        w.scrollView.bounces = false
        w.translatesAutoresizingMaskIntoConstraints = false
        content.insertSubview(w, at: 0)
        NSLayoutConstraint.activate([
            w.topAnchor.constraint(equalTo: content.topAnchor),
            w.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            w.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            w.trailingAnchor.constraint(equalTo: content.trailingAnchor),
        ])
        web = w
        load(px)
    }
    private func load(_ px: DeviceProxy) {
        guard let w = web, let url = URL(string: px.url) else { return }
        errorPanel?.removeFromSuperview()
        errorPanel = nil
        origin = "http://127.0.0.1:\(px.port)"
        receiver = "__plyRemote" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        hello = false
        let ucc = w.configuration.userContentController
        ucc.removeAllUserScripts()
        if let script = remoteScript() {
            ucc.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        w.load(URLRequest(url: url))
    }

    private func remoteScript() -> String? {
        guard let file = Bundle.main.url(forResource: "plyremote", withExtension: "js"),
              let template = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        let rec = try? device.store.host(hostId)
        let name = rec.map { $0.label.isEmpty ? $0.hostName : $0.label } ?? ""
        let info: JSON = ["hostId": .string(hostId), "hostName": .string(name), "relay": .string(rec?.relayUrl ?? ""),
                          "device": .string(PleiadShell.deviceName)]
        return ShellBridge.hostScript(template: template, info: info, origin: origin, receiver: receiver)
    }

    private func pushStatus(_ s: LinkStatus) {
        guard hello, let w = web else { return }
        w.evaluateJavaScript(ShellBridge.deliver(receiver: receiver, message: ["type": .string("status"), "status": s.json]))
    }
    func enterBackground() {
        web?.evaluateJavaScript("window.dispatchEvent(new Event('plyremote:stop'))")
    }

    // 戻ったシーンだけを復帰させる。ポートが移った場合は新しい URL を開く。
    func enterForeground() {
        let id = hostId
        HostViewController.worker.async { [weak self, device] in
            let moved = device.resumeForeground()
            DispatchQueue.main.async {
                guard let self, !self.left, let px = self.proxy, !px.closed else { return }
                if moved.contains(id) { self.load(px) }
                let st = px.link.state
                if st == "offline" || st == "host-offline" { px.retryNow() }
                self.web?.evaluateJavaScript("window.dispatchEvent(new Event('plyremote:start'))")
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.webView === web, message.frameInfo.isMainFrame else { return }
        let o = message.frameInfo.securityOrigin
        guard "\(o.protocol)://\(o.host):\(o.port)" == origin, let text = message.body as? String,
              let data = text.data(using: .utf8), let m = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        switch m["type"] as? String {
        case "hello":
            hello = true
            if let px = proxy { pushStatus(px.link.status) }
        case "retry": proxy?.retryNow()
        case "theme": applyTheme(m)
        case "back": leave(forget: true)
        default: break
        }
    }
    private func applyBars(_ dark: Bool, _ top: UIColor, _ bottom: UIColor) {
        self.dark = dark
        topBand.backgroundColor = top
        view.backgroundColor = bottom
        web?.backgroundColor = bottom
        setNeedsStatusBarAppearanceUpdate()
    }
    private func applyTheme(_ m: [String: Any]) {
        func color(_ key: String) -> UIColor? {
            ShellBridge.color(m[key] as? String).map { UIColor(red: CGFloat($0.r) / 255, green: CGFloat($0.g) / 255, blue: CGFloat($0.b) / 255, alpha: 1) }
        }
        applyBars(m["dark"] as? Bool ?? dark, color("top") ?? topBand.backgroundColor ?? .white,
                  color("bottom") ?? view.backgroundColor ?? .white)
    }

    private func originOf(_ u: URL) -> String { "\(u.scheme?.lowercased() ?? ""):\u{2f}/\(u.host ?? ""):\(u.port ?? -1)" }
    private func linkTarget(_ u: URL) -> LinkTarget {
        LinkPolicy.classify(scheme: u.scheme, host: u.host, port: u.port, path: u.path, hasUserInfo: u.user != nil || u.password != nil,
                            proxyPort: proxy?.port ?? -1)
    }

    private func openOutside(_ u: URL) {
        switch linkTarget(u) {
        case .external: UIApplication.shared.open(u)
        case .hostOnly: showNotice(ShellTexts.linkHostOnly)
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if webView === popup { return decisionHandler(place(webView, action)) }
        guard webView === web, let u = action.request.url else { return decisionHandler(.cancel) }
        if action.shouldPerformDownload {
            return decisionHandler(originOf(u) == origin || u.scheme == "blob" ? .download : .cancel)
        }
        if originOf(u) == origin { return decisionHandler(.allow) }
        let mainFrame = action.targetFrame?.isMainFrame ?? true
        if !mainFrame, ["about", "blob", "data"].contains(u.scheme?.lowercased() ?? "") { return decisionHandler(.allow) }
        if mainFrame { openOutside(u) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        if webView === web, (response.isForMainFrame && !response.canShowMIMEType) || disposition.lowercased().hasPrefix("attachment") {
            return decisionHandler(.download)
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === web { spinner.stopAnimating() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if webView === web { spinner.stopAnimating() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if webView === web, (error as NSError).code != NSURLErrorCancelled {
            showError(ShellTexts.hostOpenFailed)
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === web, let px = proxy, !left { load(px) } else if webView === popup { closePopup() }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if webView === popup {
            if let u = action.request.url { webView.load(URLRequest(url: u)) }
            return nil
        }
        guard webView === web, !left else { return nil }
        if let u = action.request.url, !u.absoluteString.isEmpty, u.absoluteString != "about:blank", linkTarget(u) != .snapshot {
            openOutside(u)
            return nil
        }
        closePopup()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let p = WKWebView(frame: .zero, configuration: configuration)
        p.navigationDelegate = self
        p.uiDelegate = self
        popup = p
        titleWatch = p.observe(\.title) { [weak self] v, _ in
            if v === self?.popup { self?.sheetTitle?.text = v.title }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self, weak p] in
            if let self, let p, self.popup === p, self.sheet == nil { self.closePopup() }
        }
        return p
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView === popup { closePopup() }
    }
    private func place(_ p: WKWebView, _ action: WKNavigationAction) -> WKNavigationActionPolicy {
        guard let u = action.request.url else { return .cancel }
        if !(action.targetFrame?.isMainFrame ?? true) || u.absoluteString == "about:blank" { return .allow }
        if linkTarget(u) == .snapshot {
            if p === popup && sheet == nil { showSheet(p) }
            return p === popup ? .allow : .cancel
        }
        openOutside(u)
        if p === popup && sheet == nil {
            DispatchQueue.main.async { [weak self] in if let self, self.popup === p, self.sheet == nil { self.closePopup() } }
        }
        return .cancel
    }
    private func showSheet(_ p: WKWebView) {
        let paper = topBand.backgroundColor ?? (dark ? HostViewController.darkPaper : .white)
        let ink = HostViewController.luminance(paper) < 0.4
            ? UIColor(red: 0xdf / 255.0, green: 0xe3 / 255.0, blue: 0xf2 / 255.0, alpha: 1)
            : UIColor(red: 0x1c / 255.0, green: 0x22 / 255.0, blue: 0x47 / 255.0, alpha: 1)
        let title = UILabel()
        title.textColor = ink
        title.font = .preferredFont(forTextStyle: .headline)
        title.lineBreakMode = .byTruncatingTail
        title.text = p.title
        var cfg = UIButton.Configuration.plain()
        cfg.title = ShellTexts.sheetClose
        cfg.baseForegroundColor = ink
        let close = UIButton(configuration: cfg, primaryAction: UIAction { [weak self] _ in self?.closePopup() })
        close.setContentHuggingPriority(.required, for: .horizontal)
        let bar = UIStackView(arrangedSubviews: [title, close])
        bar.alignment = .center
        bar.spacing = 8
        bar.isLayoutMarginsRelativeArrangement = true
        bar.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 20, bottom: 8, trailing: 8)
        let s = UIStackView(arrangedSubviews: [bar, p])
        s.axis = .vertical
        s.backgroundColor = paper
        s.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(s)
        NSLayoutConstraint.activate([
            s.topAnchor.constraint(equalTo: content.topAnchor),
            s.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            s.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            s.trailingAnchor.constraint(equalTo: content.trailingAnchor),
        ])
        sheet = s
        sheetTitle = title
    }

    private static func luminance(_ c: UIColor) -> CGFloat {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        c.getRed(&r, green: &g, blue: &b, alpha: &a)
        return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }

    private func closePopup() {
        guard let p = popup else { return }
        popup = nil
        titleWatch = nil
        sheet?.removeFromSuperview()
        sheet = nil
        sheetTitle = nil
        p.stopLoading()
        p.removeFromSuperview()
    }
    private func showNotice(_ text: String) {
        let label = PaddedLabel()
        label.text = text
        label.numberOfLines = 0
        label.textColor = .white
        label.backgroundColor = UIColor(white: 0.1, alpha: 0.9)
        label.layer.cornerRadius = 10
        label.layer.masksToBounds = true
        label.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -32),
            label.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -48),
        ])
        UIView.animate(withDuration: 0.3, delay: 2.5, options: []) { label.alpha = 0 } completion: { _ in label.removeFromSuperview() }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentDialog(a) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: ShellTexts.scanCancel, style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentDialog(a) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        a.addTextField { $0.text = defaultText }
        a.addAction(UIAlertAction(title: ShellTexts.scanCancel, style: .cancel) { _ in completionHandler(nil) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { [weak a] _ in completionHandler(a?.textFields?.first?.text ?? "") })
        presentDialog(a) { completionHandler(nil) }
    }
    private func presentDialog(_ a: UIViewController, otherwise: () -> Void) {
        if left || presentedViewController != nil || view.window == nil { return otherwise() }
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloadTasks[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloadTasks[ObjectIdentifier(download)] = download
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return completionHandler(nil)
        }
        let name = (suggestedFilename as NSString).lastPathComponent
        let file = dir.appendingPathComponent(name.isEmpty || name == "." || name == ".." ? "download" : name)
        downloads[ObjectIdentifier(download)] = file
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        downloadTasks.removeValue(forKey: ObjectIdentifier(download))
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        guard !left, presentedViewController == nil else { return removeDownload(file) }
        exportDirectory = file.deletingLastPathComponent()
        let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        picker.delegate = self
        present(picker, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadTasks.removeValue(forKey: ObjectIdentifier(download))
        if let file = downloads.removeValue(forKey: ObjectIdentifier(download)) { removeDownload(file) }
    }

    // 保存・キャンセル後は受信した原本を残さない。保存先は利用者が選んだコピー。
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { clearExport() }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { clearExport() }

    private func clearExport() {
        if let dir = exportDirectory { try? FileManager.default.removeItem(at: dir) }
        exportDirectory = nil
    }

    private func removeDownload(_ file: URL) { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }

}
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(c, didReceive: message)
    }
}

private final class PaddedLabel: UILabel {
    private let inset = UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: inset)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + inset.left + inset.right, height: s.height + inset.top + inset.bottom)
    }
}
