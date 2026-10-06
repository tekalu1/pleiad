// Where a link pressed in the host window goes on this device (docs/remote.md §8.5), and whether a launch opens the
// last host (§8.2). Pure, so the rules are unit-tested; the same rules as LinkPolicy.kt / ResumePolicy.kt,
// desktop/remote-windows.cjs (linkTarget) and web/host-only-links.mjs (isHostOnlyUrl).

public enum LinkTarget: Equatable {
    /// The host's saved copy of a visualization on this window's proxy: shown in the app (the proxy's cookie is here only)
    case snapshot
    /// A web page: the device's default browser
    case external
    /// localhost / loopback: it means the host's PC, but on this device it would open the device itself
    case hostOnly
    /// Anything else (other schemes, credentials in the URL, other pages of the proxy): nothing opens
    case blocked
}

public enum LinkPolicy {
    public static let SNAPSHOT_PATH = "/visualization-snapshot"

    private static func isLoopbackV4(_ h: String) -> Bool {
        let parts = h.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4, parts[0] == "127" else { return false }
        return parts.dropFirst().allSatisfy { p in (1...3).contains(p.count) && p.allSatisfy { $0.isASCII && $0.isNumber } }
    }

    public static func isLoopbackHost(_ host: String?) -> Bool {
        guard var h = host?.lowercased() else { return false }
        if h.hasPrefix("[") && h.hasSuffix("]") && h.count >= 2 { h = String(h.dropFirst().dropLast()) }
        if h.hasSuffix(".") { h.removeLast() }
        return h == "localhost" || h.hasSuffix(".localhost") || isLoopbackV4(h) || h == "0.0.0.0" ||
            h == "::1" || h == "::" || h.hasPrefix("::ffff:127.") || h.hasPrefix("::ffff:7f")
    }

    /// - Parameters:
    ///   - port: nil when the URL has none
    ///   - proxyPort: the port of this window's in-app proxy (http://127.0.0.1:<proxyPort>)
    public static func classify(scheme: String?, host: String?, port: Int?, path: String?, hasUserInfo: Bool, proxyPort: Int) -> LinkTarget {
        guard let s = scheme?.lowercased() else { return .blocked }
        if s != "http" && s != "https" { return .blocked }
        guard let host, !host.isEmpty, !hasUserInfo else { return .blocked }
        let effectivePort = port ?? (s == "https" ? 443 : 80)
        if s == "http" && host == "127.0.0.1" && effectivePort == proxyPort {
            return path == SNAPSHOT_PATH ? .snapshot : .blocked
        }
        return isLoopbackHost(host) ? .hostOnly : .external
    }
}

/// What the launch should do about the host the user was in last: open [hostId], or [forget] the saved one.
public struct ResumeDecision: Equatable {
    public let hostId: String?
    public let forget: Bool
    public init(_ hostId: String?, _ forget: Bool) {
        self.hostId = hostId
        self.forget = forget
    }
}

/// Whether the app opens straight into the last host instead of showing the host list.
///
/// Opens only when the start is a fresh launch (not a state restoration, not a pleiad://pair link) and the saved host is
/// still paired and not revoked. A saved host that no longer qualifies is forgotten, so it is not checked again at
/// every start.
public enum ResumePolicy {
    public static func decide(saved: String?, hosts: [HostRecord], freshStart: Bool, launcherStart: Bool) -> ResumeDecision {
        guard let saved, !saved.isEmpty else { return ResumeDecision(nil, false) }
        guard let host = hosts.first(where: { $0.hostId == saved }), host.revokedAt == nil else { return ResumeDecision(nil, true) }
        if !freshStart || !launcherStart { return ResumeDecision(nil, false) }
        return ResumeDecision(saved, false)
    }
}
