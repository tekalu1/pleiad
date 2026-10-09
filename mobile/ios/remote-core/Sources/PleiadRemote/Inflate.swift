import Foundation

// Raw deflate (RFC 1951) in plain Swift, for the gzip of the static bundle (StaticCache.swift). The same code runs on
// Apple and in the Windows / Linux tests, so the gzip path the app uses is the one `swift test` covers everywhere.
// Decoding follows zlib's contrib/puff (canonical codes from the lengths), with a 9-bit table in front for the short codes.

enum Inflate {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// The decompressed bytes of one deflate stream, at most `max` of them. Throws on a malformed or truncated stream.
    static func inflate(_ input: ArraySlice<UInt8>, max: Int) throws -> Bytes {
        var s = State(input: Array(input), max: max)
        try s.run()
        return s.out
    }

    private static let FAST = 9
    private static let LEN_BASE: [Int] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
    private static let LEN_EXTRA: [Int] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
    private static let DIST_BASE: [Int] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
                                           1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
    private static let DIST_EXTRA: [Int] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
    private static let CL_ORDER: [Int] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

    private static let fixed: (Huffman, Huffman) = {
        var lit = [UInt8](repeating: 8, count: 288)
        for i in 144..<256 { lit[i] = 9 }
        for i in 256..<280 { lit[i] = 7 }
        return (try! Huffman(lit), try! Huffman([UInt8](repeating: 5, count: 30)))
    }()

    /// A canonical Huffman code. Over-subscribed lengths are refused; an incomplete code is allowed (a single distance
    /// code is legal), and reading one of its unused codes fails at decode time.
    struct Huffman {
        var count = [Int](repeating: 0, count: 16)   // codes per length
        var symbol: [Int] = []                        // symbols ordered by code
        var fast = [Int32](repeating: 0, count: 1 << FAST)   // reversed low bits -> symbol | length << 16 (0: not short)

        init(_ lengths: [UInt8]) throws {
            for l in lengths { count[Int(l)] += 1 }
            count[0] = 0
            var left = 1
            for len in 1...15 {
                left = left << 1 - count[len]
                if left < 0 { throw Failure(description: "over-subscribed code") }
            }
            var offs = [Int](repeating: 0, count: 16)
            for len in 1..<15 { offs[len + 1] = offs[len] + count[len] }
            symbol = [Int](repeating: 0, count: lengths.count)
            for (sym, l) in lengths.enumerated() where l != 0 { symbol[offs[Int(l)]] = sym; offs[Int(l)] += 1 }
            // the short codes: canonical code -> its bit-reversed form, repeated over the unused high bits
            var code = 0, index = 0
            for len in 1...FAST {
                for _ in 0..<count[len] {
                    var rev = 0
                    for b in 0..<len where code & (1 << b) != 0 { rev |= 1 << (len - 1 - b) }
                    let entry = Int32(symbol[index] | len << 16)
                    var i = rev
                    while i < 1 << FAST { fast[i] = entry; i += 1 << len }
                    code += 1
                    index += 1
                }
                code <<= 1
            }
        }
    }

    private struct State {
        let input: [UInt8]
        let max: Int
        var pos = 0
        var bitBuf: UInt64 = 0
        var bitCount = 0
        var out = Bytes()

        init(input: [UInt8], max: Int) {
            self.input = input
            self.max = max
            out.reserveCapacity(Swift.min(max, input.count * 4))
        }

        mutating func run() throws {
            var last = false
            while !last {
                last = try bits(1) == 1
                switch try bits(2) {
                case 0: try stored()
                case 1: try codes(Inflate.fixed.0, Inflate.fixed.1)
                case 2:
                    let (lit, dist) = try dynamicCodes()
                    try codes(lit, dist)
                default: throw Failure(description: "bad block type")
                }
            }
        }

        /// Fill the bit buffer up to `n` bits when the input has them.
        @inline(__always)
        mutating func fill(_ n: Int) {
            while bitCount < n, pos < input.count {
                bitBuf |= UInt64(input[pos]) << UInt64(bitCount)
                pos += 1
                bitCount += 8
            }
        }

        @inline(__always)
        mutating func bits(_ n: Int) throws -> Int {
            if n == 0 { return 0 }
            fill(n)
            if bitCount < n { throw Failure(description: "truncated deflate") }
            let v = Int(bitBuf & (1 << UInt64(n) - 1))
            bitBuf >>= UInt64(n)
            bitCount -= n
            return v
        }

        mutating func stored() throws {
            // to the byte boundary; whole bytes already in the buffer go back to the input
            bitBuf = 0
            pos -= bitCount >> 3
            bitCount = 0
            guard pos + 4 <= input.count else { throw Failure(description: "truncated deflate") }
            let len = Int(input[pos]) | Int(input[pos + 1]) << 8
            let nlen = Int(input[pos + 2]) | Int(input[pos + 3]) << 8
            pos += 4
            guard len == ~nlen & 0xffff else { throw Failure(description: "bad stored length") }
            guard pos + len <= input.count else { throw Failure(description: "truncated deflate") }
            guard out.count + len <= max else { throw Failure(description: "too large") }
            out += input[pos..<(pos + len)]
            pos += len
        }

        mutating func decode(_ h: Huffman) throws -> Int {
            fill(15)
            let e = h.fast[Int(bitBuf & UInt64((1 << FAST) - 1))]
            let elen = Int(e >> 16)
            if elen != 0, elen <= bitCount {
                bitBuf >>= UInt64(elen)
                bitCount -= elen
                return Int(e & 0xffff)
            }
            // a long code (or near the end of the input): bit by bit, as puff does
            var code = 0, first = 0, index = 0
            for len in 1...15 {
                code |= try bits(1)
                let count = h.count[len]
                if code - count < first { return h.symbol[index + (code - first)] }
                index += count
                first += count
                first <<= 1
                code <<= 1
            }
            throw Failure(description: "bad code")
        }

        mutating func dynamicCodes() throws -> (Huffman, Huffman) {
            let nlen = try bits(5) + 257
            let ndist = try bits(5) + 1
            let ncode = try bits(4) + 4
            guard nlen <= 286, ndist <= 30 else { throw Failure(description: "bad counts") }
            var cl = [UInt8](repeating: 0, count: 19)
            for i in 0..<ncode { cl[CL_ORDER[i]] = UInt8(try bits(3)) }
            let clCode = try Huffman(cl)
            var lengths = [UInt8](repeating: 0, count: nlen + ndist)
            var i = 0
            while i < nlen + ndist {
                let sym = try decode(clCode)
                if sym < 16 { lengths[i] = UInt8(sym); i += 1; continue }
                var value: UInt8 = 0
                let rep: Int
                switch sym {
                case 16:
                    guard i > 0 else { throw Failure(description: "repeat with no length") }
                    value = lengths[i - 1]
                    rep = 3 + (try bits(2))
                case 17: rep = 3 + (try bits(3))
                default: rep = 11 + (try bits(7))
                }
                guard i + rep <= nlen + ndist else { throw Failure(description: "too many lengths") }
                for _ in 0..<rep { lengths[i] = value; i += 1 }
            }
            guard lengths[256] != 0 else { throw Failure(description: "no end-of-block code") }
            return (try Huffman(Array(lengths[0..<nlen])), try Huffman(Array(lengths[nlen...])))
        }

        mutating func codes(_ lit: Huffman, _ dist: Huffman) throws {
            while true {
                let sym = try decode(lit)
                if sym < 256 {
                    guard out.count < max else { throw Failure(description: "too large") }
                    out.append(UInt8(sym))
                    continue
                }
                if sym == 256 { return }
                let li = sym - 257
                guard li < 29 else { throw Failure(description: "bad length code") }
                let len = LEN_BASE[li] + (try bits(LEN_EXTRA[li]))
                let di = try decode(dist)
                guard di < 30 else { throw Failure(description: "bad distance code") }
                let d = DIST_BASE[di] + (try bits(DIST_EXTRA[di]))
                guard d <= out.count else { throw Failure(description: "distance too far back") }
                guard out.count + len <= max else { throw Failure(description: "too large") }
                // byte by byte: the copy may overlap what it writes (d < len), and a slice of `out` would copy all of it
                let from = out.count - d
                for k in 0..<len { out.append(out[from + k]) }
            }
        }
    }
}
