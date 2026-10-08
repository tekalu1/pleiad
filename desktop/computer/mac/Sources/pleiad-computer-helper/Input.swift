// 入力（ADR 0173 §3）。CGEvent を HID の段（.cghidEventTap）へ送る。座標はグローバルの point。
// 押したままのキー（コード）とボタンを覚え、releaseAll で押したものだけを離す。押している修飾キーは、送るすべての event の flags に載せる。
// 文字は keyboardSetUnicodeString で送る。日本語の入力ソース（かな）が選ばれていると変換中の文字列に取り込まれるので、打つ間だけ ASCII の入力ソースへ切り替える。
#if canImport(AppKit) && canImport(ScreenCaptureKit)
import Foundation
import CoreGraphics
import Carbon.HIToolbox
import ComputerProtocol

final class InputDriver {
    static let shared = InputDriver()

    private var heldKeys: [UInt16] = []
    private var heldButtons: [String] = []
    private let source = CGEventSource(stateID: .hidSystemState)

    private var flags: CGEventFlags { CGEventFlags(rawValue: modifierFlags(heldKeys)) }

    func cursor() -> [String: Any] {
        let point = CGEvent(source: nil)?.location ?? .zero
        return ["x": Double(point.x), "y": Double(point.y)]
    }

    // ---- マウス --------------------------------------------------------------------------------

    private struct ButtonTypes {
        let button: CGMouseButton
        let down: CGEventType
        let up: CGEventType
        let dragged: CGEventType
    }

    private func types(_ name: String) throws -> ButtonTypes {
        switch name {
        case "left": return ButtonTypes(button: .left, down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged)
        case "right": return ButtonTypes(button: .right, down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged)
        case "middle": return ButtonTypes(button: .center, down: .otherMouseDown, up: .otherMouseUp, dragged: .otherMouseDragged)
        default: throw HelperError(.failed, "unknown button: \(name)")
        }
    }

    /** { event: move | down | up, x?, y?, button?, clickState? }。x・y が無ければ今のカーソルの位置 */
    func mouse(_ args: [String: Any]) throws {
        try Permissions.requireAccessibility()
        let kind = args["event"] as? String ?? "move"
        let current = CGEvent(source: nil)?.location ?? .zero
        let point = CGPoint(x: doubleValue(args["x"]) ?? Double(current.x), y: doubleValue(args["y"]) ?? Double(current.y))
        let name = args["button"] as? String ?? "left"
        var button = try types(name)
        let type: CGEventType
        switch kind {
        case "move":
            // ボタンを押したままの移動は dragged にする（mouseMoved だとドラッグにならないアプリがある）
            if let held = heldButtons.last {
                button = try types(held)
                type = button.dragged
            } else {
                type = .mouseMoved
            }
        case "down":
            type = button.down
            if !heldButtons.contains(name) { heldButtons.append(name) }
        case "up":
            type = button.up
            heldButtons.removeAll { $0 == name }
        default:
            throw HelperError(.failed, "unknown mouse event: \(kind)")
        }
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button.button) else {
            throw HelperError(.failed, "could not create a mouse event")
        }
        if kind != "move" {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(min(3, max(1, intValue(args["clickState"]) ?? 1))))
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    /** { dy, dx, count }。行の単位で count 回（上・右が正） */
    func scroll(_ args: [String: Any]) throws {
        try Permissions.requireAccessibility()
        let dy = Int32(clamping: intValue(args["dy"]) ?? 0)
        let dx = Int32(clamping: intValue(args["dx"]) ?? 0)
        let count = min(200, max(1, intValue(args["count"]) ?? 1))
        for _ in 0..<count {
            guard let event = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) else {
                throw HelperError(.failed, "could not create a scroll event")
            }
            event.flags = flags
            event.post(tap: .cghidEventTap)
            usleep(2000)
        }
    }

    // ---- キー ----------------------------------------------------------------------------------

    private func requireInsecureInput() throws {
        if IsSecureEventInputEnabled() { throw HelperError(.secureInput, "secure input is on (a password field is focused)") }
    }

    /** { code, down }。離すときは安全な入力の中でも送る（押したままにしない） */
    func key(_ args: [String: Any]) throws {
        try Permissions.requireAccessibility()
        guard let raw = intValue(args["code"]), raw >= 0, raw < 0x80 else { throw HelperError(.failed, "code must be 0...127") }
        let code = UInt16(raw)
        let down = args["down"] as? Bool ?? true
        if down {
            try requireInsecureInput()
            if !heldKeys.contains(code) { heldKeys.append(code) }
        } else {
            heldKeys.removeAll { $0 == code }
        }
        try postKey(code, down: down)
    }

    private func postKey(_ code: UInt16, down: Bool) throws {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: down) else {
            throw HelperError(.failed, "could not create a key event")
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }

    /** 1 文字ずつ、今のキー配列で打つキー（{ code, shift }）。引けなければ US 配列、それも無ければ null */
    func resolve(_ chars: [String]) -> [Any] {
        let layout = layoutMap()
        return chars.map { text -> Any in
            guard text.count == 1, let ch = text.first else { return NSNull() }
            if let hit = layout[ch] ?? usKey(for: ch) { return ["code": Int(hit.code), "shift": hit.shift] }
            return NSNull()
        }
    }

    /** UCKeyTranslate で、今のキー配列の「文字 → キーとシフト」の表を作る */
    private func layoutMap() -> [Character: (code: UInt16, shift: Bool)] {
        var map: [Character: (code: UInt16, shift: Bool)] = [:]
        let candidates: [() -> Unmanaged<TISInputSource>?] = [{ TISCopyCurrentKeyboardLayoutInputSource() }, { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() }]
        for candidate in candidates {
            guard let source = candidate()?.takeRetainedValue(),
                  let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { continue }
            let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
            let keyboardType = UInt32(LMGetKbdType())
            data.withUnsafeBytes { buffer in
                guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return }
                for shift in [false, true] {
                    let modifiers: UInt32 = shift ? UInt32((shiftKey >> 8) & 0xff) : 0
                    for code in 0..<0x80 {
                        var dead: UInt32 = 0
                        var length = 0
                        var chars = [UniChar](repeating: 0, count: 4)
                        let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), modifiers, keyboardType,
                                                    OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
                        guard status == 0, length == 1, chars[0] >= 0x20, chars[0] != 0x7f, let scalar = Unicode.Scalar(chars[0]) else { continue }
                        let ch = Character(scalar)
                        if map[ch] == nil { map[ch] = (UInt16(code), shift) }
                    }
                }
            }
            if !map.isEmpty { break }
        }
        return map
    }

    // ---- 文字 ----------------------------------------------------------------------------------

    /** { text }。改行は Return、タブは Tab のキーで、ほかは Unicode の文字で送る */
    func text(_ args: [String: Any]) throws {
        try Permissions.requireAccessibility()
        try requireInsecureInput()
        guard let text = args["text"] as? String else { throw HelperError(.failed, "text must be a string") }
        let restore = selectASCIIInputSource()
        defer {
            if let restore {
                usleep(50_000) // 送った event が届く前に戻すと、かなの入力ソースで受けてしまう
                restore()
            }
        }
        for ch in text {
            switch ch {
            case "\n", "\r\n", "\r": try tap(UInt16(kVK_Return))
            case "\t": try tap(UInt16(kVK_Tab))
            default:
                let units = Array(String(ch).utf16)
                if units.count == 1, units[0] < 0x20 || units[0] == 0x7f { continue }
                try postUnicode(units)
            }
            usleep(1000)
        }
    }

    private func tap(_ code: UInt16) throws {
        try postKey(code, down: true)
        try postKey(code, down: false)
    }

    private func postUnicode(_ units: [UniChar]) throws {
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
                throw HelperError(.failed, "could not create a key event")
            }
            event.flags = []
            units.withUnsafeBufferPointer { buffer in
                if let base = buffer.baseAddress { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base) }
            }
            event.post(tap: .cghidEventTap)
        }
    }

    /** 今の入力ソースが ASCII を打てなければ、ASCII の入力ソースへ切り替え、戻す関数を返す */
    private func selectASCIIInputSource() -> (() -> Void)? {
        guard let current = TISCopyCurrentKeyboardInputSource()?.takeRetainedValue() else { return nil }
        if let raw = TISGetInputSourceProperty(current, kTISPropertyInputSourceIsASCIICapable),
           CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(raw).takeUnretainedValue()) { return nil }
        guard let ascii = TISCopyCurrentASCIICapableKeyboardInputSource()?.takeRetainedValue(),
              TISSelectInputSource(ascii) == 0 else { return nil }
        usleep(30_000)
        return { _ = TISSelectInputSource(current) }
    }

    // ---- 離す ----------------------------------------------------------------------------------

    /** 押したままのボタンとキーを離し、離したものの名前を返す */
    func releaseAll() -> [String] {
        var released: [String] = []
        let point = CGEvent(source: nil)?.location ?? .zero
        for name in heldButtons.reversed() {
            if let button = try? types(name), let event = CGEvent(mouseEventSource: source, mouseType: button.up, mouseCursorPosition: point, mouseButton: button.button) {
                event.flags = flags
                event.post(tap: .cghidEventTap)
            }
            released.append(name)
        }
        heldButtons.removeAll()
        while let code = heldKeys.popLast() {
            try? postKey(code, down: false)
            released.append("kVK_\(code)")
        }
        return released
    }
}
#endif
