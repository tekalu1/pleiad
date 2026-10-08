// 殻とページの間の値・失敗コード・スクリプト。OS に依存せず試験できる部分（ADR 0174）。
import Foundation
public struct VaultError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}

public enum ShellBridge {
    public static func hostEntry(_ h: HostRecord, _ st: LinkStatus?) -> JSON {
        var o = h.publicJson
        o.set("state", .string(st?.state ?? (h.revokedAt != nil ? "revoked" : "closed")))
        o.set("open", .bool(st != nil))
        return o
    }
    public static func offer(_ payload: String?, known: (String) throws -> Bool) throws -> JSON {
        let o = try PairingCodec.parse(payload)
        return ["hostId": .string(o.hostId), "hostName": .string(PairingCodec.cleanLabel(o.hostName)), "relayUrl": .string(o.relayUrl),
                "known": .bool(try known(o.hostId))]
    }
    public static func statusEvent(_ hostId: String, _ s: LinkStatus) -> JSON { s.json.with("hostId", .string(hostId)) }
    public static func failure(_ e: Error) -> (code: String, message: String, data: JSON?) {
        if let p = e as? PairError {
            return (p.code, p.description, ["detail": .string(p.detail), "closeCode": p.closeCode.map { .int(Int64($0)) } ?? .null])
        }
        if let v = e as? VaultError { return ("storage", v.description, nil) }
        let text = String(describing: e)
        return (text == "unknown-host" ? "unknown-host" : "internal", text, nil)
    }
    public static func foundation(_ j: JSON) -> Any {
        switch j {
        case .null: return NSNull()
        case .bool(let b): return b
        case .int(let i): return i
        case .double(let d): return d
        case .string(let s): return s
        case .array(let a): return a.map(foundation)
        case .object(let o): return o.mapValues(foundation)
        }
    }

    public static func foundationObject(_ j: JSON) -> [String: Any] { (foundation(j) as? [String: Any]) ?? [:] }
    public static func color(_ s: String?) -> (r: UInt8, g: UInt8, b: UInt8)? {
        guard let s, s.utf8.count == 7, s.hasPrefix("#") else { return nil }
        let digits = s.dropFirst()
        guard digits.allSatisfy({ $0.isHexDigit && $0.isASCII }), let v = UInt32(digits, radix: 16) else { return nil }
        return (UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff))
    }
    public static func isPairLink(scheme: String?, host: String?) -> Bool {
        scheme?.lowercased() == "pleiad" && host?.lowercased() == "pair"
    }
    public static func hostScript(template: String, info: JSON, origin: String, receiver: String) -> String {
        template
            .replacingOccurrences(of: "__PLY_ORIGIN__", with: JSON.string(origin).serialized)
            .replacingOccurrences(of: "__PLY_RECEIVER__", with: JSON.string(receiver).serialized)
            .replacingOccurrences(of: "__PLY_INFO__", with: info.serialized)
    }
    public static func deliver(receiver: String, message: JSON) -> String {
        let name = JSON.string(receiver).serialized
        return "(() => { const f = window[\(name)]; if (typeof f === 'function') f(\(JSON.string(message.serialized).serialized)); })()"
    }
}
