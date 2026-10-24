import Foundation

/// A failure the plugin rejects with; `code` is what the TypeScript side acts on.
public struct CodePushError: Error, LocalizedError, Equatable {
    public static let downloadFailed = "DOWNLOAD_FAILED"
    public static let invalidPackage = "INVALID_PACKAGE"
    public static let hashMismatch = "HASH_MISMATCH"
    public static let signatureUnsupported = "SIGNATURE_UNSUPPORTED"
    public static let notStaged = "NOT_STAGED"
    public static let invalidArgument = "INVALID_ARGUMENT"

    public let code: String
    public let message: String

    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// An update as the server described it, plus the binary version it was downloaded on.
public struct PackageMetadata: Codable, Equatable {
    public var deploymentKey: String
    public var description: String
    public var label: String
    public var appVersion: String
    public var isMandatory: Bool
    public var packageHash: String
    public var packageSize: Int64

    public init(deploymentKey: String, description: String, label: String, appVersion: String, isMandatory: Bool,
                packageHash: String, packageSize: Int64) {
        self.deploymentKey = deploymentKey
        self.description = description
        self.label = label
        self.appVersion = appVersion
        self.isMandatory = isMandatory
        self.packageHash = packageHash
        self.packageSize = packageSize
    }

    /// From the loosely typed dictionary the bridge hands over; nil without a package hash.
    public init?(dictionary: [String: Any]) {
        guard let hash = dictionary["packageHash"] as? String else { return nil }
        self.init(
            deploymentKey: dictionary["deploymentKey"] as? String ?? "",
            description: dictionary["description"] as? String ?? "",
            label: dictionary["label"] as? String ?? "",
            appVersion: dictionary["appVersion"] as? String ?? "",
            isMandatory: dictionary["isMandatory"] as? Bool ?? false,
            packageHash: hash,
            packageSize: (dictionary["packageSize"] as? NSNumber)?.int64Value ?? 0)
    }

    public var dictionary: [String: Any] {
        [
            "deploymentKey": deploymentKey,
            "description": description,
            "label": label,
            "appVersion": appVersion,
            "isMandatory": isMandatory,
            "packageHash": packageHash,
            "packageSize": packageSize
        ]
    }
}

/// What identifies one installation of the binary; a change of any field resets every update.
public struct BinaryIdentity: Codable, Equatable {
    public var versionName: String
    public var versionCode: String
    public var buildStamp: String

    public init(versionName: String, versionCode: String, buildStamp: String) {
        self.versionName = versionName
        self.versionCode = versionCode
        self.buildStamp = buildStamp
    }
}

/// An installed update not yet confirmed. `isLoading` is set once it has been launched.
public struct PendingUpdate: Codable, Equatable {
    public var packageHash: String
    public var installMode: Int
    public var minimumBackgroundDuration: Int
    public var isLoading: Bool
}

public enum InstallModes {
    public static let immediate = 0
    public static let onNextRestart = 1
    public static let onNextResume = 2
}

/// What JavaScript is asked to send to the server; the same shape as the TypeScript `StatusReport`.
public struct StatusReport: Codable, Equatable {
    public static let succeeded = "DeploymentSucceeded"
    public static let failed = "DeploymentFailed"

    public var status: String?
    public var appVersion: String?
    public var package: PackageMetadata?
    public var previousLabelOrAppVersion: String?
    public var previousDeploymentKey: String?

    public init(status: String? = nil, appVersion: String? = nil, package: PackageMetadata? = nil,
                previousLabelOrAppVersion: String? = nil, previousDeploymentKey: String? = nil) {
        self.status = status
        self.appVersion = appVersion
        self.package = package
        self.previousLabelOrAppVersion = previousLabelOrAppVersion
        self.previousDeploymentKey = previousDeploymentKey
    }

    public init(dictionary: [String: Any]) {
        self.init(
            status: dictionary["status"] as? String,
            appVersion: dictionary["appVersion"] as? String,
            package: (dictionary["package"] as? [String: Any]).flatMap(PackageMetadata.init(dictionary:)),
            previousLabelOrAppVersion: dictionary["previousLabelOrAppVersion"] as? String,
            previousDeploymentKey: dictionary["previousDeploymentKey"] as? String)
    }

    public var dictionary: [String: Any] {
        var result: [String: Any] = [:]
        if let status { result["status"] = status }
        if let appVersion { result["appVersion"] = appVersion }
        if let package { result["package"] = package.dictionary }
        if let previousLabelOrAppVersion { result["previousLabelOrAppVersion"] = previousLabelOrAppVersion }
        if let previousDeploymentKey { result["previousDeploymentKey"] = previousDeploymentKey }
        return result
    }
}

/// Everything the plugin remembers, kept in one file so a transition is one atomic write.
public struct CodePushState: Codable, Equatable {
    public static let schema = 1

    public var binary: BinaryIdentity?
    public var current: PackageMetadata?
    public var previous: PackageMetadata?
    public var pending: PendingUpdate?
    public var failedHashes: [String] = []
    public var rollbackReport: PackageMetadata?
    public var binaryHash: String?
    public var lastReportedIdentifier: String?
    public var retryReport: StatusReport?

    public init(binary: BinaryIdentity? = nil, lastReportedIdentifier: String? = nil, retryReport: StatusReport? = nil) {
        self.binary = binary
        self.lastReportedIdentifier = lastReportedIdentifier
        self.retryReport = retryReport
    }

    private struct Telemetry: Codable {
        var lastReportedIdentifier: String?
        var retryReport: StatusReport?
    }

    private enum CodingKeys: String, CodingKey {
        case schema, binary, current, previous, pending, failedHashes, rollbackReport, binaryHash, telemetry
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        binary = try container.decodeIfPresent(BinaryIdentity.self, forKey: .binary)
        current = try container.decodeIfPresent(PackageMetadata.self, forKey: .current)
        previous = try container.decodeIfPresent(PackageMetadata.self, forKey: .previous)
        pending = try container.decodeIfPresent(PendingUpdate.self, forKey: .pending)
        failedHashes = try container.decodeIfPresent([String].self, forKey: .failedHashes) ?? []
        rollbackReport = try container.decodeIfPresent(PackageMetadata.self, forKey: .rollbackReport)
        binaryHash = try container.decodeIfPresent(String.self, forKey: .binaryHash)
        let telemetry = try container.decodeIfPresent(Telemetry.self, forKey: .telemetry)
        lastReportedIdentifier = telemetry?.lastReportedIdentifier
        retryReport = telemetry?.retryReport
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Self.schema, forKey: .schema)
        try container.encodeIfPresent(binary, forKey: .binary)
        try container.encodeIfPresent(current, forKey: .current)
        try container.encodeIfPresent(previous, forKey: .previous)
        try container.encodeIfPresent(pending, forKey: .pending)
        try container.encode(failedHashes, forKey: .failedHashes)
        try container.encodeIfPresent(rollbackReport, forKey: .rollbackReport)
        try container.encodeIfPresent(binaryHash, forKey: .binaryHash)
        try container.encode(
            Telemetry(lastReportedIdentifier: lastReportedIdentifier, retryReport: retryReport), forKey: .telemetry)
    }
}

/// Logging for the core: the plugin points it at Capacitor's log, tests leave it on print.
public enum CodePushLog {
    public static var sink: (String) -> Void = { print("[CodePush] \($0)") }

    static func info(_ message: String) { sink(message) }
}
