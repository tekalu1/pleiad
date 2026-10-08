// AVFoundation の QR 読み取りを、www が使う BarcodeScanner の API で公開する（ADR 0174）。
import AVFoundation
import UIKit
import Capacitor
@objc(QRScannerPlugin)
final class QRScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "QRScannerPlugin"
    let jsName = "BarcodeScanner"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isGoogleBarcodeScannerModuleAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installGoogleBarcodeScannerModule", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
    ]

    private static func cameraState() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "granted"
        case .notDetermined: return "prompt"
        default: return "denied"
        }
    }

    @objc override func checkPermissions(_ call: CAPPluginCall) {
        call.resolve(["camera": QRScannerPlugin.cameraState()])
    }

    @objc override func requestPermissions(_ call: CAPPluginCall) {
        if AVCaptureDevice.authorizationStatus(for: .video) != .notDetermined {
            return call.resolve(["camera": QRScannerPlugin.cameraState()])
        }
        AVCaptureDevice.requestAccess(for: .video) { _ in
            call.resolve(["camera": QRScannerPlugin.cameraState()])
        }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": AVCaptureDevice.default(for: .video) != nil])
    }
    @objc func isGoogleBarcodeScannerModuleAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func installGoogleBarcodeScannerModule(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let presenter = self?.bridge?.viewController else { return call.reject("no window") }
            guard presenter.presentedViewController == nil else { return call.reject("scanner busy") }
            guard QRScannerPlugin.cameraState() == "granted" else { return call.reject("camera denied") }
            guard AVCaptureDevice.default(for: .video) != nil else { return call.reject("no camera on this device") }
            let vc = ScanViewController { result in
                switch result {
                case .found(let text): call.resolve(["barcodes": [["rawValue": text, "displayValue": text, "format": "QR_CODE"]]])
                case .cancelled: call.resolve(["barcodes": [Any]()])
                }
            }
            do {
                try vc.prepare()
            } catch {
                return call.reject(String(describing: error))
            }
            vc.modalPresentationStyle = .fullScreen
            presenter.present(vc, animated: true)
        }
    }
}
final class ScanViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    enum Result {
        case found(String)
        case cancelled
    }

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "pleiad-scan")
    private var preview: AVCaptureVideoPreviewLayer?
    private var done: ((Result) -> Void)?

    init(done: @escaping (Result) -> Void) {
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        let p = AVCaptureVideoPreviewLayer(session: session)
        p.videoGravity = .resizeAspectFill
        view.layer.addSublayer(p)
        preview = p

        let hint = UILabel()
        hint.text = ShellTexts.scanHint
        hint.textColor = .white
        hint.font = .preferredFont(forTextStyle: .body)
        hint.numberOfLines = 0
        hint.textAlignment = .center
        hint.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hint)

        var cfg = UIButton.Configuration.filled()
        cfg.title = ShellTexts.scanCancel
        cfg.baseBackgroundColor = UIColor(white: 0.15, alpha: 0.85)
        cfg.baseForegroundColor = .white
        cfg.cornerStyle = .capsule
        let cancel = UIButton(configuration: cfg, primaryAction: UIAction { [weak self] _ in self?.finish(.cancelled) })
        cancel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancel)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            hint.topAnchor.constraint(equalTo: g.topAnchor, constant: 24),
            hint.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 24),
            hint.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -24),
            cancel.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -24),
            cancel.centerXAnchor.constraint(equalTo: g.centerXAnchor),
        ])
    }
    func prepare() throws {
        guard let camera = AVCaptureDevice.default(for: .video) else { throw ScanError("no camera") }
        let input = try AVCaptureDeviceInput(device: camera)
        let output = AVCaptureMetadataOutput()
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input), session.canAddOutput(output) else { throw ScanError("camera busy") }
        session.addInput(input)
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        guard output.availableMetadataObjectTypes.contains(.qr) else { throw ScanError("QR not supported") }
        output.metadataObjectTypes = [.qr]
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        if let c = preview?.connection, c.isVideoOrientationSupported, let o = view.window?.windowScene?.interfaceOrientation {
            c.videoOrientation = AVCaptureVideoOrientation(rawValue: o.rawValue) ?? .portrait
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        sessionQueue.async { [session] in if !session.isRunning { session.startRunning() } }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        sessionQueue.async { [session] in if session.isRunning { session.stopRunning() } }
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first(where: { $0.type == .qr }),
              let text = code.stringValue, !text.isEmpty else { return }
        finish(.found(text))
    }
    private func finish(_ result: Result) {
        guard let done else { return }
        self.done = nil
        if presentingViewController != nil {
            dismiss(animated: true) { done(result) }
        } else {
            DispatchQueue.main.async { [weak self] in
                if self?.presentingViewController != nil { self?.dismiss(animated: true) }
                done(result)
            }
        }
    }
}

private struct ScanError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
