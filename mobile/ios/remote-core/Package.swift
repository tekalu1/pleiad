// swift-tools-version:6.0
// Pleiad remote device side for iOS (docs/remote.md §3・§4・§7・§8, ADR 0144): the Swift port of
// mobile/android/remote-core. Pure Swift so the protocol is tested with `swift test` against tests/remote/vectors.json
// and a real Node relay + host (InteropTests). The iOS shell (stage 2) depends on it as a local package.
//
// Crypto: CryptoKit on Apple platforms, swift-crypto (the same API) elsewhere (Windows / Linux, for tests only).
import PackageDescription

let package = Package(
    name: "PleiadRemote",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "PleiadRemote", targets: ["PleiadRemote"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", exact: "4.5.2"),
    ],
    targets: [
        .target(
            name: "PleiadRemote",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto", condition: .when(platforms: [.linux, .windows, .android])),
            ]
        ),
        .testTarget(name: "PleiadRemoteTests", dependencies: ["PleiadRemote"]),
    ],
    swiftLanguageModes: [.v5]
)
