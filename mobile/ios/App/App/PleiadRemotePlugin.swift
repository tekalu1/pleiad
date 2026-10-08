// 同梱の一覧用の API。Android と同じメソッド・応答・イベントを返す。通知は対象外（ADR 0086）。
import Foundation
import Capacitor
import PleiadRemote
@objc(PleiadRemotePlugin)
final class PleiadRemotePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PleiadRemotePlugin"
    let jsName = "PleiadRemote"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "parse", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelPair", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "rename", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takePairLink", returnType: CAPPluginReturnPromise),
    ]

    private static let worker = DispatchQueue(label: "pleiad-plugin", qos: .userInitiated, attributes: .concurrent)
    private static weak var instance: PleiadRemotePlugin?
    private static let linkLock = NSLock()
    private static var pendingLink: String?
    static func offerLink(_ payload: String) {
        linkLock.lock(); pendingLink = payload; linkLock.unlock()
        instance?.notifyListeners("pairLink", data: [:])
    }

    private let pairLock = NSLock()
    private var pairing: Pairing?
    private var statusToken: Int?

    override func load() {
        PleiadRemotePlugin.instance = self
        statusToken = PleiadShell.device?.onStatus { [weak self] hostId, s in
            self?.notifyListeners("status", data: ShellBridge.foundationObject(ShellBridge.statusEvent(hostId, s)))
        }
    }

    deinit {
        if let statusToken { PleiadShell.device?.offStatus(statusToken) }
    }

    private func bg(_ call: CAPPluginCall, _ fn: @escaping (RemoteDevice) throws -> Void) {
        PleiadRemotePlugin.worker.async {
            do { try fn(PleiadShell.requireDevice()) } catch {
                let f = ShellBridge.failure(error)
                call.reject(f.message, f.code, nil, f.data.map(ShellBridge.foundationObject))
            }
        }
    }

    @objc func info(_ call: CAPPluginCall) {
        bg(call) { device in
            call.resolve(["deviceName": PleiadShell.deviceName, "app": device.app, "encrypted": device.store.protected])
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        bg(call) { device in
            let hosts = try device.list().map { ShellBridge.foundation(ShellBridge.hostEntry($0.0, $0.1)) }
            call.resolve(["hosts": hosts])
        }
    }
    @objc func parse(_ call: CAPPluginCall) {
        bg(call) { device in
            let offer = try ShellBridge.offer(call.getString("payload")) { try device.store.host($0) != nil }
            call.resolve(ShellBridge.foundationObject(offer))
        }
    }
    @objc func pair(_ call: CAPPluginCall) {
        guard let payload = call.getString("payload") else { return call.reject("payload", "payload") }
        let handle = Pairing()
        pairLock.lock()
        pairing?.cancel()
        pairing = handle
        pairLock.unlock()
        bg(call) { [weak self] device in
            defer {
                if let self {
                    self.pairLock.lock()
                    if self.pairing === handle { self.pairing = nil }
                    self.pairLock.unlock()
                }
            }
            let rec = try device.pair(payload, onCode: { code in self?.notifyListeners("pairCode", data: ["code": code]) }, handle: handle)
            call.resolve(["host": ShellBridge.foundation(rec.publicJson)])
        }
    }

    @objc func cancelPair(_ call: CAPPluginCall) {
        pairLock.lock()
        pairing?.cancel()
        pairing = nil
        pairLock.unlock()
        call.resolve()
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let hostId = call.getString("hostId") else { return call.reject("hostId", "unknown-host") }
        bg(call) { [weak self] device in
            if try device.store.host(hostId) == nil { throw UnknownHost() }
            DispatchQueue.main.async {
                guard let root = self?.bridge?.viewController as? PleiadBridgeViewController,
                      root.openHost(hostId) else { return call.reject("host window unavailable", "internal") }
                call.resolve()
            }
        }
    }

    @objc func rename(_ call: CAPPluginCall) {
        bg(call) { device in
            guard let rec = try device.rename(call.getString("hostId") ?? "", call.getString("label") ?? "") else { throw UnknownHost() }
            call.resolve(["host": ShellBridge.foundation(rec.publicJson)])
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        bg(call) { device in
            let hostId = call.getString("hostId") ?? ""
            try device.remove(hostId)
            ResumeStore.forget(hostId)
            call.resolve()
        }
    }
    @objc func takePairLink(_ call: CAPPluginCall) {
        PleiadRemotePlugin.linkLock.lock()
        let p = PleiadRemotePlugin.pendingLink
        PleiadRemotePlugin.pendingLink = nil
        PleiadRemotePlugin.linkLock.unlock()
        call.resolve(["payload": p.map { $0 as Any } ?? NSNull()])
    }
}
private struct UnknownHost: Error, CustomStringConvertible {
    var description: String { "unknown-host" }
}
