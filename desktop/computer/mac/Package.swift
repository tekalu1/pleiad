// swift-tools-version:5.9
// computer use の macOS のヘルパー（ADR 0173・docs/computer-use.md「macOS」）。Electron の main が子プロセスとして起こし、
// 標準入出力の JSON Lines で撮影・入力・アプリの特定を頼む。
//
// ComputerProtocol は Foundation だけで書き、Windows の Swift でも `swift build` / `swift test` が通る（JSON Lines・座標・キーの表）。
// pleiad-computer-helper の本体（ScreenCaptureKit・CGEvent・AppKit・Accessibility）は `#if canImport(AppKit)` の中だけにある。
// 配布用のユニバーサルバイナリ: swift build -c release --arch arm64 --arch x86_64
import PackageDescription

let package = Package(
    name: "PleiadComputerHelper",
    // SCScreenshotManager を使うため macOS 14 以上
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "pleiad-computer-helper", targets: ["pleiad-computer-helper"]),
    ],
    targets: [
        .target(name: "ComputerProtocol"),
        .executableTarget(name: "pleiad-computer-helper", dependencies: ["ComputerProtocol"]),
        .testTarget(name: "ComputerProtocolTests", dependencies: ["ComputerProtocol"]),
    ],
    swiftLanguageVersions: [.v5]
)
