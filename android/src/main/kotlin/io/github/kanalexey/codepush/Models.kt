package io.github.kanalexey.codepush

import org.json.JSONArray
import org.json.JSONObject

/** A failure the plugin rejects with; [code] is what the TypeScript side acts on. */
class CodePushException(val code: String, message: String, cause: Throwable? = null) : Exception(message, cause) {
    companion object {
        const val DOWNLOAD_FAILED = "DOWNLOAD_FAILED"
        const val INVALID_PACKAGE = "INVALID_PACKAGE"
        const val HASH_MISMATCH = "HASH_MISMATCH"
        const val SIGNATURE_UNSUPPORTED = "SIGNATURE_UNSUPPORTED"
        const val NOT_STAGED = "NOT_STAGED"
        const val INVALID_ARGUMENT = "INVALID_ARGUMENT"
    }
}

/** An update as the server described it, plus the binary version it was downloaded on. */
data class PackageMetadata(
    val deploymentKey: String,
    val description: String,
    val label: String,
    val appVersion: String,
    val isMandatory: Boolean,
    val packageHash: String,
    val packageSize: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("deploymentKey", deploymentKey)
        .put("description", description)
        .put("label", label)
        .put("appVersion", appVersion)
        .put("isMandatory", isMandatory)
        .put("packageHash", packageHash)
        .put("packageSize", packageSize)

    companion object {
        fun fromJson(json: JSONObject) = PackageMetadata(
            deploymentKey = json.optString("deploymentKey"),
            description = json.optString("description"),
            label = json.optString("label"),
            appVersion = json.optString("appVersion"),
            isMandatory = json.optBoolean("isMandatory"),
            packageHash = json.getString("packageHash"),
            packageSize = json.optLong("packageSize"),
        )
    }
}

/** What identifies one installation of the binary; a change of any field resets every update. */
data class BinaryIdentity(val versionName: String, val versionCode: String, val buildStamp: String) {
    fun toJson(): JSONObject = JSONObject()
        .put("versionName", versionName)
        .put("versionCode", versionCode)
        .put("buildStamp", buildStamp)

    companion object {
        fun fromJson(json: JSONObject) = BinaryIdentity(
            json.optString("versionName"),
            json.optString("versionCode"),
            json.optString("buildStamp"),
        )
    }
}

/** An installed update not yet confirmed. [isLoading] is set once it has been launched. */
data class PendingUpdate(
    val packageHash: String,
    val installMode: Int,
    val minimumBackgroundDuration: Int,
    val isLoading: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("packageHash", packageHash)
        .put("installMode", installMode)
        .put("minimumBackgroundDuration", minimumBackgroundDuration)
        .put("isLoading", isLoading)

    companion object {
        fun fromJson(json: JSONObject) = PendingUpdate(
            json.getString("packageHash"),
            json.optInt("installMode"),
            json.optInt("minimumBackgroundDuration"),
            json.optBoolean("isLoading"),
        )
    }
}

object InstallModes {
    const val IMMEDIATE = 0
    const val ON_NEXT_RESTART = 1
    const val ON_NEXT_RESUME = 2
}

/** What JavaScript is asked to send to the server; the same shape as the TypeScript `StatusReport`. */
data class StatusReport(
    val status: String? = null,
    val appVersion: String? = null,
    val pkg: PackageMetadata? = null,
    val previousLabelOrAppVersion: String? = null,
    val previousDeploymentKey: String? = null,
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
        status?.let { json.put("status", it) }
        appVersion?.let { json.put("appVersion", it) }
        pkg?.let { json.put("package", it.toJson()) }
        previousLabelOrAppVersion?.let { json.put("previousLabelOrAppVersion", it) }
        previousDeploymentKey?.let { json.put("previousDeploymentKey", it) }
        return json
    }

    companion object {
        const val SUCCEEDED = "DeploymentSucceeded"
        const val FAILED = "DeploymentFailed"

        fun fromJson(json: JSONObject) = StatusReport(
            status = json.optStringOrNull("status"),
            appVersion = json.optStringOrNull("appVersion"),
            pkg = json.optJSONObject("package")?.let { PackageMetadata.fromJson(it) },
            previousLabelOrAppVersion = json.optStringOrNull("previousLabelOrAppVersion"),
            previousDeploymentKey = json.optStringOrNull("previousDeploymentKey"),
        )
    }
}

/** Everything the plugin remembers, kept in one file so a transition is one atomic write. */
data class CodePushState(
    val binary: BinaryIdentity? = null,
    val current: PackageMetadata? = null,
    val previous: PackageMetadata? = null,
    val pending: PendingUpdate? = null,
    val failedHashes: List<String> = emptyList(),
    val rollbackReport: PackageMetadata? = null,
    val binaryHash: String? = null,
    val lastReportedIdentifier: String? = null,
    val retryReport: StatusReport? = null,
) {
    fun toJson(): JSONObject {
        val json = JSONObject().put("schema", SCHEMA)
        binary?.let { json.put("binary", it.toJson()) }
        current?.let { json.put("current", it.toJson()) }
        previous?.let { json.put("previous", it.toJson()) }
        pending?.let { json.put("pending", it.toJson()) }
        json.put("failedHashes", JSONArray(failedHashes))
        rollbackReport?.let { json.put("rollbackReport", it.toJson()) }
        binaryHash?.let { json.put("binaryHash", it) }
        val telemetry = JSONObject()
        lastReportedIdentifier?.let { telemetry.put("lastReportedIdentifier", it) }
        retryReport?.let { telemetry.put("retryReport", it.toJson()) }
        return json.put("telemetry", telemetry)
    }

    companion object {
        const val SCHEMA = 1

        fun fromJson(json: JSONObject): CodePushState {
            val failed = json.optJSONArray("failedHashes")
            val telemetry = json.optJSONObject("telemetry") ?: JSONObject()
            return CodePushState(
                binary = json.optJSONObject("binary")?.let { BinaryIdentity.fromJson(it) },
                current = json.optJSONObject("current")?.let { PackageMetadata.fromJson(it) },
                previous = json.optJSONObject("previous")?.let { PackageMetadata.fromJson(it) },
                pending = json.optJSONObject("pending")?.let { PendingUpdate.fromJson(it) },
                failedHashes = (0 until (failed?.length() ?: 0)).map { failed!!.getString(it) },
                rollbackReport = json.optJSONObject("rollbackReport")?.let { PackageMetadata.fromJson(it) },
                binaryHash = json.optStringOrNull("binaryHash"),
                lastReportedIdentifier = telemetry.optStringOrNull("lastReportedIdentifier"),
                retryReport = telemetry.optJSONObject("retryReport")?.let { StatusReport.fromJson(it) },
            )
        }
    }
}

internal fun JSONObject.optStringOrNull(name: String): String? =
    if (has(name) && !isNull(name)) getString(name) else null
