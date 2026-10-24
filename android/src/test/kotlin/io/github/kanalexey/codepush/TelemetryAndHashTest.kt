package io.github.kanalexey.codepush

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

class TelemetryTest {
    @Test
    fun `an update report names the previous package by key and label`() {
        val report = Telemetry.updateReport(metadata("q", "v9", key = "k2"), "k1:v8")!!

        assertEquals(StatusReport.SUCCEEDED, report.status)
        assertEquals("v8", report.previousLabelOrAppVersion)
        assertEquals("k1", report.previousDeploymentKey)
        assertNull(Telemetry.updateReport(metadata("q", "v9", key = "k2"), "k2:v9"))
    }

    @Test
    fun `a binary report names the previous app version, or nothing the first time`() {
        assertEquals(StatusReport(appVersion = "2.0.0"), Telemetry.binaryReport("2.0.0", null))
        assertEquals(
            StatusReport(appVersion = "2.0.0", previousLabelOrAppVersion = "1.9.0"),
            Telemetry.binaryReport("2.0.0", "1.9.0"),
        )
        assertNull(Telemetry.binaryReport("2.0.0", "2.0.0"))
    }

    @Test
    fun `a successful report moves the identifier, a failure report does not`() {
        assertEquals("key-1:v-q", Telemetry.identifierAfter(StatusReport(status = StatusReport.SUCCEEDED, pkg = metadata("q"))))
        assertEquals("2.0.0", Telemetry.identifierAfter(StatusReport(appVersion = "2.0.0")))
        assertNull(Telemetry.identifierAfter(Telemetry.rollbackReport(metadata("q"))))
    }

    @Test
    fun `cordova-plugin-code-push's last version maps onto an identifier`() {
        assertEquals("k1:v12", Telemetry.identifierFromLegacy("v12", "k1"))
        assertEquals("9.9.601", Telemetry.identifierFromLegacy("9.9.601", "k1"))
        assertEquals("v12", Telemetry.identifierFromLegacy("v12", null))
        assertNull(Telemetry.identifierFromLegacy(null, "k1"))
    }

    @Test
    fun `a status report survives a round trip through JSON`() {
        val report = StatusReport(
            status = StatusReport.FAILED,
            pkg = metadata("q"),
            previousLabelOrAppVersion = "v1",
            previousDeploymentKey = "k",
        )

        assertEquals(report, StatusReport.fromJson(JSONObject(report.toJson().toString())))
        assertEquals(StatusReport(appVersion = "1.0"), StatusReport.fromJson(StatusReport(appVersion = "1.0").toJson()))
    }
}

class PackageHasherTest {
    private val fixture = File("../test/fixtures/hash")

    @Test
    fun `the shared fixture hashes to the value the Revopush CLI computes`() {
        val expected = JSONObject(File(fixture, "expected.json").readText()).getString("packageHash")
        val releaseRoot = File(fixture, "release/www")

        assertEquals(expected, PackageHasher.hash(DirectoryTree(releaseRoot), releaseRoot.name))
    }

    @Test
    fun `strings are quoted exactly as JSON stringify quotes them`() {
        val values = listOf("plain", "a\"b", "c\\d", "tab\there", "\u0001", "/slash/", "ünï", "\uD83D\uDE00", "\uD800")

        assertEquals(
            "[\"plain\",\"a\\\"b\",\"c\\\\d\",\"tab\\there\",\"\\u0001\",\"/slash/\",\"ünï\",\"\uD83D\uDE00\",\"\\ud800\"]",
            PackageHasher.jsonStringify(values),
        )
    }

    @Test
    fun `the ignore rules are the CLI's`() {
        assertEquals(true, PackageHasher.isIgnored(".DS_Store"))
        assertEquals(true, PackageHasher.isIgnored("www/a/.DS_Store"))
        assertEquals(true, PackageHasher.isIgnored("__MACOSX/x"))
        assertEquals(false, PackageHasher.isIgnored("www/__MACOSX/x"))
        assertEquals(false, PackageHasher.isIgnored("www/.codepushrelease"))
    }
}
