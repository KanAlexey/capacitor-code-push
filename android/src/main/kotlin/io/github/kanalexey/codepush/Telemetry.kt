package io.github.kanalexey.codepush

/**
 * Which status report is due, following react-native-code-push's telemetry manager. The last report the server
 * took is remembered as an identifier: `<deploymentKey>:<label>` for a package, the app version for the binary.
 */
object Telemetry {
    fun packageIdentifier(pkg: PackageMetadata): String = "${pkg.deploymentKey}:${pkg.label}"

    /** A report for a package that just ran for the first time, or null when the server already has it. */
    fun updateReport(pkg: PackageMetadata, lastReportedIdentifier: String?): StatusReport? {
        if (lastReportedIdentifier == packageIdentifier(pkg)) {
            return null
        }
        return withPrevious(StatusReport(status = StatusReport.SUCCEEDED, pkg = pkg), lastReportedIdentifier)
    }

    /** A report for the store bundle of [appVersion], or null when the server already has it. */
    fun binaryReport(appVersion: String, lastReportedIdentifier: String?): StatusReport? {
        if (lastReportedIdentifier == appVersion) {
            return null
        }
        return withPrevious(StatusReport(appVersion = appVersion), lastReportedIdentifier)
    }

    fun rollbackReport(pkg: PackageMetadata) = StatusReport(status = StatusReport.FAILED, pkg = pkg)

    /** What [report] makes the last reported identifier once the server took it; null leaves it unchanged. */
    fun identifierAfter(report: StatusReport): String? = when {
        report.status == StatusReport.FAILED -> null
        report.pkg != null -> packageIdentifier(report.pkg)
        report.appVersion != null -> report.appVersion
        else -> null
    }

    /**
     * The identifier cordova-plugin-code-push's last report leaves behind: it stored a label or an app version
     * beside a deployment key, and only a label pairs with a key here.
     */
    fun identifierFromLegacy(labelOrAppVersion: String?, deploymentKey: String?): String? = when {
        labelOrAppVersion.isNullOrEmpty() -> null
        LABEL.matches(labelOrAppVersion) && !deploymentKey.isNullOrEmpty() -> "$deploymentKey:$labelOrAppVersion"
        else -> labelOrAppVersion
    }

    private val LABEL = Regex("^v\\d+$")

    private fun withPrevious(report: StatusReport, previous: String?): StatusReport {
        if (previous == null) {
            return report
        }
        val separator = previous.indexOf(':')
        return if (separator >= 0) {
            report.copy(
                previousDeploymentKey = previous.substring(0, separator),
                previousLabelOrAppVersion = previous.substring(separator + 1),
            )
        } else {
            report.copy(previousLabelOrAppVersion = previous)
        }
    }
}
