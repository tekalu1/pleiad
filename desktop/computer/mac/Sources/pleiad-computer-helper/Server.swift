// 標準入力を読む糸と、頼みを順に捌く main の RunLoop（ADR 0173 §1）。
// 頼みは main のスレッドで 1 つずつ捌く（AppKit・TIS・AX は main で呼ぶ）。撮影と起動は完了の callback から答える。
// main の RunLoop を回し続けるのは、NSWorkspace.frontmostApplication を新しく保つため（回さないと古い値のまま）。
#if canImport(AppKit) && canImport(ScreenCaptureKit)
import Foundation
import ComputerProtocol

typealias Reply = (Result<[String: Any], HelperError>) -> Void

final class HelperServer {
    private let writeLock = NSLock()

    func write(_ data: Data) {
        writeLock.lock()
        defer { writeLock.unlock() }
        FileHandle.standardOutput.write(data)
    }

    func run() -> Never {
        signal(SIGPIPE, SIG_IGN) // main が先に閉じても落ちない（書けなければ EOF で終わる）
        write(helloLine(os: osVersion(), arch: architecture()))
        let reader = Thread { [self] in readLoop() }
        reader.start()
        let keepAlive = Timer(timeInterval: 3600, repeats: true) { _ in }
        RunLoop.main.add(keepAlive, forMode: .default)
        while true { _ = RunLoop.main.run(mode: .default, before: .distantFuture) }
    }

    private func readLoop() {
        var splitter = LineSplitter()
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty { // main が閉じた（Pleiad の終了・落ちた）。押したままを離して終わる
                DispatchQueue.main.async {
                    _ = InputDriver.shared.releaseAll()
                    exit(0)
                }
                return
            }
            for line in splitter.push(chunk) {
                guard let request = parseRequest(line) else {
                    FileHandle.standardError.write(Data("ignored a line that is not a request\n".utf8))
                    continue
                }
                DispatchQueue.main.async { [self] in handle(request) }
            }
        }
    }

    private func handle(_ request: Request) {
        let reply: Reply = { [self] result in
            switch result {
            case .success(let data): write(okLine(id: request.id, data: data))
            case .failure(let error): write(errorLine(id: request.id, error))
            }
        }
        do {
            if let data = try perform(request, reply: reply) { reply(.success(data)) }
        } catch let error as HelperError {
            reply(.failure(error))
        } catch {
            reply(.failure(HelperError(.failed, String(describing: error))))
        }
    }

    /** すぐ答えられる頼みは data を返す。後で答える頼み（capture・launch）は nil を返し、reply を呼ぶ */
    private func perform(_ request: Request, reply: @escaping Reply) throws -> [String: Any]? {
        let args = request.args
        switch request.op {
        case "ping": return [:]
        case "permissions": return Permissions.status()
        case "request": return ["granted": Permissions.request(args["permission"] as? String ?? "")]
        case "session": return Session.state()
        case "capture": try Capture.capture(args, reply: reply); return nil
        case "cursor": return InputDriver.shared.cursor()
        case "mouse": try InputDriver.shared.mouse(args); return [:]
        case "scroll": try InputDriver.shared.scroll(args); return [:]
        case "key": try InputDriver.shared.key(args); return [:]
        case "keys": return ["keys": InputDriver.shared.resolve(args["chars"] as? [String] ?? [])]
        case "text": try InputDriver.shared.text(args); return [:]
        case "releaseAll": return ["released": InputDriver.shared.releaseAll()]
        case "appAt": return ["app": orNull(try Apps.at(args))]
        case "foreground": return ["app": orNull(Apps.foreground())]
        case "apps": return Apps.list()
        case "launch": try Apps.launch(args, reply: reply); return nil
        case "activate": return ["activated": try Apps.activate(args)]
        default: throw HelperError(.failed, "unknown op: \(request.op)")
        }
    }

    private func orNull(_ value: [String: Any]?) -> Any {
        if let value { return value }
        return NSNull()
    }

    private func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private func architecture() -> String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }
}
#endif
