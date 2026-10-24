import Foundation

/// Which status report is due, following react-native-code-push's telemetry manager. The last report the server
/// took is remembered as an identifier: `<deploymentKey>:<label>` for a package, the app version for the binary.
public enum Telemetry {
    public static func packageIdentifier(_ package: PackageMetadata) -> String {
        "\(package.deploymentKey):\(package.label)"
    }

    /// A report for a package that just ran for the first time, or nil when the server already has it.
    public static func updateReport(_ package: PackageMetadata, lastReportedIdentifier: String?) -> StatusReport? {
        guard lastReportedIdentifier != packageIdentifier(package) else { return nil }
        return withPrevious(StatusReport(status: StatusReport.succeeded, package: package), lastReportedIdentifier)
    }

    /// A report for the store bundle of `appVersion`, or nil when the server already has it.
    public static func binaryReport(_ appVersion: String, lastReportedIdentifier: String?) -> StatusReport? {
        guard lastReportedIdentifier != appVersion else { return nil }
        return withPrevious(StatusReport(appVersion: appVersion), lastReportedIdentifier)
    }

    public static func rollbackReport(_ package: PackageMetadata) -> StatusReport {
        StatusReport(status: StatusReport.failed, package: package)
    }

    /// What `report` makes the last reported identifier once the server took it; nil leaves it unchanged.
    public static func identifier(after report: StatusReport) -> String? {
        if report.status == StatusReport.failed { return nil }
        if let package = report.package { return packageIdentifier(package) }
        return report.appVersion
    }

    /// The identifier cordova-plugin-code-push's last report leaves behind: it stored a label or an app version
    /// beside a deployment key, and only a label pairs with a key here.
    public static func identifierFromLegacy(labelOrAppVersion: String?, deploymentKey: String?) -> String? {
        guard let value = labelOrAppVersion, !value.isEmpty else { return nil }
        let isLabel = value.range(of: "^v[0-9]+$", options: .regularExpression) != nil
        if isLabel, let key = deploymentKey, !key.isEmpty {
            return "\(key):\(value)"
        }
        return value
    }

    private static func withPrevious(_ report: StatusReport, _ previous: String?) -> StatusReport {
        guard let previous else { return report }
        var result = report
        if let separator = previous.firstIndex(of: ":") {
            result.previousDeploymentKey = String(previous[..<separator])
            result.previousLabelOrAppVersion = String(previous[previous.index(after: separator)...])
        } else {
            result.previousLabelOrAppVersion = previous
        }
        return result
    }
}
