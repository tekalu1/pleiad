// 一覧とホストの窓で共有する RemoteDevice。シーンを作る前に初期化する。
import UIKit
import PleiadRemote
enum PleiadShell {
    private(set) static var device: RemoteDevice?
    private static var startError: Error?
    private(set) static var deviceName = ""

    @MainActor
    static func start() {
        if device != nil { return }
        deviceName = UIDevice.current.name
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        do {
            device = RemoteDevice(store: try openStore(), app: app, name: deviceName, platform: "ios", texts: ProxyWords(),
                                  log: { NSLog("Pleiad: %@", $0) })
        } catch {
            startError = VaultError("remote store: \(error)")
        }
    }

    static func requireDevice() throws -> RemoteDevice {
        guard let device else { throw startError ?? VaultError("remote store unavailable") }
        return device
    }

    private static func openStore() throws -> DeviceStore {
        let fm = FileManager.default
        let support = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var dir = support.appendingPathComponent("remote", isDirectory: true)
        let store = try DeviceStore(dir: dir, vault: KeychainVault())
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try dir.setResourceValues(values)
        return store
    }
}
