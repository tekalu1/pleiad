import XCTest
import Foundation
@testable import ComputerProtocol

final class ProtocolTests: XCTestCase {
    private func object(_ data: Data) throws -> [String: Any] {
        XCTAssertEqual(data.last, 0x0a, "1 行で終わる")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data.dropLast()) as? [String: Any])
    }

    func testParsesRequestAndRejectsBrokenLines() {
        for id in ["true", "1.5", "1e100"] {
            XCTAssertNil(parseRequest(Data("{\"id\":\(id),\"op\":\"ping\"}".utf8)))
        }
        XCTAssertNil(doubleValue(true))
        XCTAssertNil(doubleValue(Double.infinity))
        let request = parseRequest(Data(#"{"id":3,"op":"capture","args":{"display":"1"}}"#.utf8))
        XCTAssertEqual(request?.id, 3)
        XCTAssertEqual(request?.op, "capture")
        XCTAssertEqual(request?.args["display"] as? String, "1")
        XCTAssertNil(parseRequest(Data("not json".utf8)))
        XCTAssertNil(parseRequest(Data(#"{"op":"capture"}"#.utf8)), "id の無い頼みには答えられない")
        XCTAssertEqual(parseRequest(Data(#"{"id":4,"op":"cursor"}"#.utf8))?.args.count, 0)
    }

    func testOkAndErrorLines() throws {
        let ok = try object(okLine(id: 1, data: ["x": 10]))
        XCTAssertEqual(ok["id"] as? Int, 1)
        XCTAssertEqual(ok["ok"] as? Bool, true)
        XCTAssertEqual((ok["data"] as? [String: Any])?["x"] as? Int, 10)

        let failed = try object(errorLine(id: 2, HelperError(.permission, "screen recording is not allowed", extra: ["permission": "screen"])))
        XCTAssertEqual(failed["ok"] as? Bool, false)
        let error = try XCTUnwrap(failed["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "permission")
        XCTAssertEqual(error["permission"] as? String, "screen")
        XCTAssertEqual(ErrorCode.secureInput.rawValue, "secure_input")
        XCTAssertEqual(ErrorCode.notFound.rawValue, "not_found")

        let hello = try object(helloLine(os: "14.5.0", arch: "arm64"))
        XCTAssertEqual(hello["event"] as? String, "hello")
        XCTAssertEqual(hello["protocol"] as? Int, protocolVersion)
    }

    func testSplitsChunksIntoLines() {
        var splitter = LineSplitter()
        XCTAssertEqual(splitter.push(Data("{\"id\":1".utf8)).count, 0, "改行までは持つ")
        let lines = splitter.push(Data("}\r\n\n{\"id\":2}\n{\"id\"".utf8))
        XCTAssertEqual(lines.map { String(decoding: $0, as: UTF8.self) }, ["{\"id\":1}", "{\"id\":2}"])
        XCTAssertEqual(splitter.push(Data(":3}\n".utf8)).map { String(decoding: $0, as: UTF8.self) }, ["{\"id\":3}"])

        var small = LineSplitter(maxLine: 4)
        XCTAssertEqual(small.push(Data("123456".utf8)).count, 0)
        XCTAssertEqual(small.push(Data("{}\n".utf8)).map { String(decoding: $0, as: UTF8.self) }, ["{}"], "改行の無い巨大な行は捨てる")
    }

    func testRectsAndOutputSize() throws {
        let display = Rect(x: -1440, y: 0, width: 1440, height: 900)
        XCTAssertTrue(display.contains(x: -1, y: 899))
        XCTAssertFalse(display.contains(x: 0, y: 0), "右端は含まない")
        let wanted = try requireRect(["x": -100, "y": 800, "width": 400, "height": 400])
        let clipped = try XCTUnwrap(wanted.intersection(display))
        XCTAssertEqual(clipped, Rect(x: -100, y: 800, width: 100, height: 100))
        XCTAssertEqual(clipped.local(in: display), Rect(x: 1340, y: 800, width: 100, height: 100))
        XCTAssertNil(Rect(x: 0, y: 0, width: 10, height: 10).intersection(display))
        XCTAssertThrowsError(try requireRect(["x": 0, "y": 0, "width": 0, "height": 1]))

        XCTAssertEqual(try outputSize(["width": 1460, "height": 913]).width, 1460)
        XCTAssertThrowsError(try outputSize(["width": 0, "height": 10]))
        XCTAssertThrowsError(try outputSize(["width": 99999, "height": 10]))
        XCTAssertEqual(jpegQuality(75), 0.75)
        XCTAssertEqual(jpegQuality(500), 1)
        XCTAssertEqual(jpegQuality(nil), 0.75)
    }

    func testLumaMatchesTheJavaScriptWeights() {
        // capture.cjs の lumaOf: (b*29 + g*150 + r*77) >> 8
        XCTAssertEqual(luma(rgba: [255, 255, 255, 255], count: 1, bgra: false), [255])
        XCTAssertEqual(luma(rgba: [0, 0, 255, 255], count: 1, bgra: true), [76], "(0*29 + 0*150 + 255*77) >> 8")
        XCTAssertEqual(luma(rgba: [0, 0, 255, 255], count: 1, bgra: false), [28], "(255*29) >> 8")
    }

    func testKeysAndModifierFlags() {
        XCTAssertEqual(usKey(for: "a")?.code, 0x00)
        XCTAssertEqual(usKey(for: "A")?.shift, true)
        XCTAssertEqual(usKey(for: "!")?.code, 0x12)
        XCTAssertEqual(usKey(for: "!")?.shift, true)
        XCTAssertNil(usKey(for: "あ"))
        XCTAssertEqual(modifierFlags([KeyCode.command, KeyCode.shift]), 0x00120000)
        XCTAssertEqual(modifierFlags([KeyCode.returnKey]), 0)
    }
}
