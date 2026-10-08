// macOS の仮想キーコード（Carbon の kVK_*。HIToolbox/Events.h）。
// 名前のキーは main（desktop/computer/mac-keymap.cjs）がコードにして渡す。ここの表は、1 文字のキーを
// 今のキー配列（UCKeyTranslate）で引けなかったときの US 配列の予備。
import Foundation

public enum KeyCode {
    public static let returnKey: UInt16 = 0x24
    public static let tab: UInt16 = 0x30
    public static let space: UInt16 = 0x31
    public static let delete: UInt16 = 0x33
    public static let escape: UInt16 = 0x35
    public static let command: UInt16 = 0x37
    public static let shift: UInt16 = 0x38
    public static let capsLock: UInt16 = 0x39
    public static let option: UInt16 = 0x3A
    public static let control: UInt16 = 0x3B
    public static let rightCommand: UInt16 = 0x36
    public static let rightShift: UInt16 = 0x3C
    public static let rightOption: UInt16 = 0x3D
    public static let rightControl: UInt16 = 0x3E
    public static let function: UInt16 = 0x3F
}

/** 修飾キーのコード → CGEventFlags の値（maskShift など。CoreGraphics を読まずに持つ） */
public let modifierFlagBits: [UInt16: UInt64] = [
    KeyCode.shift: 0x00020000, KeyCode.rightShift: 0x00020000,
    KeyCode.control: 0x00040000, KeyCode.rightControl: 0x00040000,
    KeyCode.option: 0x00080000, KeyCode.rightOption: 0x00080000,
    KeyCode.command: 0x00100000, KeyCode.rightCommand: 0x00100000,
    KeyCode.function: 0x00800000,
]

/** 押している修飾キーの flags の和 */
public func modifierFlags(_ held: [UInt16]) -> UInt64 {
    held.reduce(0) { $0 | (modifierFlagBits[$1] ?? 0) }
}

/** US 配列で 1 文字を打つキー（shift が要るか）。無ければ nil */
public func usKey(for character: Character) -> (code: UInt16, shift: Bool)? {
    let lower: [Character: UInt16] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05, "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09,
        "b": 0x0B, "q": 0x0C, "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11, "1": 0x12, "2": 0x13, "3": 0x14,
        "4": 0x15, "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D, "]": 0x1E,
        "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23, "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29,
        "\\": 0x2A, ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32, " ": 0x31,
    ]
    let shifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]
    if let code = lower[character] { return (code, false) }
    if let base = shifted[character], let code = lower[base] { return (code, true) }
    let text = String(character)
    if text.count == 1, text.lowercased() != text, let low = text.lowercased().first, let code = lower[low] { return (code, true) }
    return nil
}
