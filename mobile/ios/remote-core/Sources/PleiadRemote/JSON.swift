import Foundation

/// A small JSON value with its own parser and writer, so the wire format does not depend on Foundation's
/// JSONSerialization quirks (NSNumber / Bool bridging on Darwin, "\/" escaping, number formatting) and behaves the
/// same on every platform. Stands in for org.json in the Kotlin port.
public enum JSON: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSON])
    case object([String: JSON])

    public subscript(key: String) -> JSON? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    public var string: String? { if case .string(let s) = self { return s }; return nil }
    public var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var object: [String: JSON]? { if case .object(let o) = self { return o }; return nil }
    public var array: [JSON]? { if case .array(let a) = self { return a }; return nil }
    public var int: Int64? {
        switch self {
        case .int(let i): return i
        case .double(let d) where d.rounded() == d && abs(d) < 9.0e15: return Int64(d)
        default: return nil
        }
    }

    /// The value as text the way org.json's toString would show a scalar (GOAWAY codes, header values).
    public var text: String {
        switch self {
        case .string(let s): return s
        default: return serialized
        }
    }

    // ── building ──

    public mutating func set(_ key: String, _ value: JSON?) {
        guard case .object(var o) = self else { return }
        o[key] = value
        self = .object(o)
    }

    public func with(_ key: String, _ value: JSON?) -> JSON {
        var c = self
        c.set(key, value)
        return c
    }

    // ── writing ──

    public var serialized: String {
        var out = ""
        write(into: &out)
        return out
    }

    public var data: Bytes { Bytes(serialized.utf8) }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d):
            if !d.isFinite { out += "null" }
            else if d.rounded() == d && abs(d) < 1e15 { out += String(Int64(d)) }
            else { out += String(d) }
        case .string(let s): JSON.writeString(s, into: &out)
        case .array(let a):
            out += "["
            for (i, v) in a.enumerated() {
                if i > 0 { out += "," }
                v.write(into: &out)
            }
            out += "]"
        case .object(let o):
            out += "{"
            var first = true
            for k in o.keys.sorted() {
                if !first { out += "," }
                first = false
                JSON.writeString(k, into: &out)
                out += ":"
                o[k]!.write(into: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if u.value < 0x20 {
                    let h = String(u.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - h.count) + h
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        out += "\""
    }

    // ── parsing ──

    public struct ParseError: Error {}

    public static func parse(_ bytes: Bytes) throws -> JSON {
        var p = Parser(b: bytes)
        p.skipSpace()
        let v = try p.value(depth: 0)
        p.skipSpace()
        if p.i != bytes.count { throw ParseError() }
        return v
    }

    public static func parse(_ text: String) throws -> JSON { try parse(Bytes(text.utf8)) }

    private struct Parser {
        let b: Bytes
        var i = 0

        mutating func skipSpace() {
            while i < b.count, b[i] == 0x20 || b[i] == 0x0a || b[i] == 0x0d || b[i] == 0x09 { i += 1 }
        }

        mutating func expect(_ s: String) throws {
            for c in s.utf8 {
                guard i < b.count, b[i] == c else { throw ParseError() }
                i += 1
            }
        }

        mutating func value(depth: Int) throws -> JSON {
            guard depth < 512, i < b.count else { throw ParseError() }
            switch b[i] {
            case UInt8(ascii: "{"):
                i += 1
                var o = [String: JSON]()
                skipSpace()
                if i < b.count, b[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                while true {
                    skipSpace()
                    let k = try string()
                    skipSpace()
                    try expect(":")
                    skipSpace()
                    let v = try value(depth: depth + 1)
                    if o[k] == nil { o[k] = v }
                    skipSpace()
                    guard i < b.count else { throw ParseError() }
                    if b[i] == UInt8(ascii: ",") { i += 1; continue }
                    if b[i] == UInt8(ascii: "}") { i += 1; return .object(o) }
                    throw ParseError()
                }
            case UInt8(ascii: "["):
                i += 1
                var a = [JSON]()
                skipSpace()
                if i < b.count, b[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                while true {
                    skipSpace()
                    a.append(try value(depth: depth + 1))
                    skipSpace()
                    guard i < b.count else { throw ParseError() }
                    if b[i] == UInt8(ascii: ",") { i += 1; continue }
                    if b[i] == UInt8(ascii: "]") { i += 1; return .array(a) }
                    throw ParseError()
                }
            case UInt8(ascii: "\""): return .string(try string())
            case UInt8(ascii: "t"): try expect("true"); return .bool(true)
            case UInt8(ascii: "f"): try expect("false"); return .bool(false)
            case UInt8(ascii: "n"): try expect("null"); return .null
            default: return try number()
            }
        }

        mutating func number() throws -> JSON {
            let start = i
            var isInt = true
            if i < b.count, b[i] == UInt8(ascii: "-") { i += 1 }
            guard i < b.count, b[i] >= 0x30, b[i] <= 0x39 else { throw ParseError() }
            if b[i] == 0x30 { i += 1 } else { while i < b.count, b[i] >= 0x30, b[i] <= 0x39 { i += 1 } }
            if i < b.count, b[i] == UInt8(ascii: ".") {
                isInt = false
                i += 1
                guard i < b.count, b[i] >= 0x30, b[i] <= 0x39 else { throw ParseError() }
                while i < b.count, b[i] >= 0x30, b[i] <= 0x39 { i += 1 }
            }
            if i < b.count, b[i] == UInt8(ascii: "e") || b[i] == UInt8(ascii: "E") {
                isInt = false
                i += 1
                if i < b.count, b[i] == UInt8(ascii: "+") || b[i] == UInt8(ascii: "-") { i += 1 }
                guard i < b.count, b[i] >= 0x30, b[i] <= 0x39 else { throw ParseError() }
                while i < b.count, b[i] >= 0x30, b[i] <= 0x39 { i += 1 }
            }
            let text = Bytes(b[start..<i]).utf8String
            if isInt, let v = Int64(text) { return .int(v) }
            guard let d = Double(text) else { throw ParseError() }
            return .double(d)
        }

        mutating func hex4() throws -> UInt32 {
            guard i + 4 <= b.count else { throw ParseError() }
            var v: UInt32 = 0
            for _ in 0..<4 {
                let c = b[i]
                i += 1
                v <<= 4
                switch c {
                case 0x30...0x39: v |= UInt32(c - 0x30)
                case 0x61...0x66: v |= UInt32(c - 0x57)
                case 0x41...0x46: v |= UInt32(c - 0x37)
                default: throw ParseError()
                }
            }
            return v
        }

        mutating func string() throws -> String {
            guard i < b.count, b[i] == UInt8(ascii: "\"") else { throw ParseError() }
            i += 1
            var out = Bytes()
            while true {
                guard i < b.count else { throw ParseError() }
                let c = b[i]
                i += 1
                if c == UInt8(ascii: "\"") { break }
                if c < 0x20 { throw ParseError() }
                if c != UInt8(ascii: "\\") { out.append(c); continue }
                guard i < b.count else { throw ParseError() }
                let e = b[i]
                i += 1
                switch e {
                case UInt8(ascii: "\""): out.append(0x22)
                case UInt8(ascii: "\\"): out.append(0x5c)
                case UInt8(ascii: "/"): out.append(0x2f)
                case UInt8(ascii: "b"): out.append(0x08)
                case UInt8(ascii: "f"): out.append(0x0c)
                case UInt8(ascii: "n"): out.append(0x0a)
                case UInt8(ascii: "r"): out.append(0x0d)
                case UInt8(ascii: "t"): out.append(0x09)
                case UInt8(ascii: "u"):
                    var cp = try hex4()
                    if cp >= 0xd800 && cp < 0xdc00, i + 6 <= b.count, b[i] == 0x5c, b[i + 1] == UInt8(ascii: "u") {
                        let save = i
                        i += 2
                        let lo = try hex4()
                        if lo >= 0xdc00 && lo < 0xe000 { cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00) } else { i = save }
                    }
                    // Lone surrogates become U+FFFD (Swift strings are valid Unicode)
                    let scalar = Unicode.Scalar(cp) ?? "\u{FFFD}"
                    out += Bytes(String(Character(scalar)).utf8)
                default: throw ParseError()
                }
            }
            return out.utf8String
        }
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral,
    ExpressibleByDictionaryLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int64) { self = .int(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(dictionaryLiteral elements: (String, JSON)...) {
        var o = [String: JSON]()
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(nilLiteral: ()) { self = .null }
}
