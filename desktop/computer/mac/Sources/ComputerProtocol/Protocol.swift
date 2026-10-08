// main（desktop/computer/mac-helper.cjs）との JSON Lines の契約（ADR 0173 §1）。
//   頼み: {"id":1,"op":"capture","args":{...}}
//   答え: {"id":1,"ok":true,"data":{...}} / {"id":1,"ok":false,"error":{"code":"permission","message":"...","permission":"screen"}}
//   起きたら最初に {"event":"hello","protocol":1,...} を 1 行出す。
import Foundation

public let protocolVersion = 1

/** 答えの error.code。desktop/computer/errors.cjs の CODES と同じ語 */
public enum ErrorCode: String {
    case permission
    case secureInput = "secure_input"
    case locked
    case outside
    case notFound = "not_found"
    case unsupported
    case failed
}

public struct HelperError: Error {
    public let code: ErrorCode
    public let message: String
    public let extra: [String: Any]
    public init(_ code: ErrorCode, _ message: String, extra: [String: Any] = [:]) {
        self.code = code
        self.message = message
        self.extra = extra
    }
}

public struct Request {
    public let id: Int
    public let op: String
    public let args: [String: Any]
}

/** 1 行を頼みにする。id の無い行・JSON でない行は nil（答えようがない） */
public func parseRequest(_ line: Data) -> Request? {
    guard let object = try? JSONSerialization.jsonObject(with: line), let dict = object as? [String: Any] else { return nil }
    guard let id = intValue(dict["id"]), let op = dict["op"] as? String else { return nil }
    return Request(id: id, op: op, args: dict["args"] as? [String: Any] ?? [:])
}

public func okLine(id: Int, data: [String: Any]) -> Data {
    encodeLine(["id": id, "ok": true, "data": data])
}

public func errorLine(id: Int, _ error: HelperError) -> Data {
    var body: [String: Any] = ["code": error.code.rawValue, "message": error.message]
    for (key, value) in error.extra { body[key] = value }
    return encodeLine(["id": id, "ok": false, "error": body])
}

public func helloLine(os: String, arch: String) -> Data {
    encodeLine(["event": "hello", "protocol": protocolVersion, "os": os, "arch": arch])
}

/** 1 つの JSON と改行。JSON にできない値は失敗の行にする */
public func encodeLine(_ object: [String: Any]) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: object, options: [])) ?? Data("{\"ok\":false}".utf8)
    data.append(0x0a)
    return data
}

/** 標準入力の塊を行に分ける。最後の改行の後ろは次の塊まで持つ */
public struct LineSplitter {
    private var buffer = Data()
    public let maxLine: Int
    public init(maxLine: Int = 8 * 1024 * 1024) { self.maxLine = maxLine }

    public mutating func push(_ chunk: Data) -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 0x0a) {
            var line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            if line.last == 0x0d { line.removeLast() }
            if !line.isEmpty { lines.append(line) }
        }
        if buffer.count > maxLine { buffer.removeAll() } // 改行の無い巨大な行は捨てる
        return lines
    }
}

// ---- 引数の読み出し ------------------------------------------------------------------------

public func intValue(_ value: Any?) -> Int? {
    // JSON の Bool は NSNumber の char 型。数値の小数・無限大・Int の範囲外も受け付けない。
    guard let n = value as? NSNumber, String(cString: n.objCType) != "c" else { return nil }
    return Int(exactly: n.doubleValue)
}

public func doubleValue(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber, String(cString: n.objCType) != "c", n.doubleValue.isFinite else { return nil }
    return n.doubleValue
}

public func requireDouble(_ args: [String: Any], _ key: String) throws -> Double {
    guard let value = doubleValue(args[key]) else { throw HelperError(.failed, "\(key) must be a number") }
    return value
}

public func requireRect(_ value: Any?, name: String = "rect") throws -> Rect {
    guard let dict = value as? [String: Any],
          let x = doubleValue(dict["x"]), let y = doubleValue(dict["y"]),
          let width = doubleValue(dict["width"]), let height = doubleValue(dict["height"]),
          width > 0, height > 0 else { throw HelperError(.failed, "\(name) must be { x, y, width, height }") }
    return Rect(x: x, y: y, width: width, height: height)
}
