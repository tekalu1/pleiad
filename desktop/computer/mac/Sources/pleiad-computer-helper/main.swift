// pleiad-computer-helper の入口（ADR 0173）。macOS では標準入力の JSON Lines を受けて答える。
// ほかの OS でも `swift build` は通るが、起こしても unsupported を出して終わる。
import Foundation
import ComputerProtocol

#if canImport(AppKit) && canImport(ScreenCaptureKit)
HelperServer().run()
#else
FileHandle.standardError.write(Data("pleiad-computer-helper runs only on macOS\n".utf8))
FileHandle.standardOutput.write(encodeLine(["event": "hello", "protocol": protocolVersion, "supported": false]))
exit(2)
#endif
