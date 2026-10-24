package io.github.kanalexey.codepush

import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal val BINARY = BinaryIdentity("2.3.4", "234", "1700000000000")

internal fun metadata(hash: String, label: String = "v-$hash", key: String = "key-1") = PackageMetadata(
    deploymentKey = key,
    description = "update $label",
    label = label,
    appVersion = BINARY.versionName,
    isMandatory = false,
    packageHash = hash,
    packageSize = 100,
)

/** Puts a package straight into the store, as a finished download would. */
internal fun StateStore.stageFake(hash: String, label: String = "v-$hash"): PackageMetadata {
    val folder = packageDir(hash).apply { mkdirs() }
    File(folder, "index.html").writeText("<title>$hash</title>")
    return metadata(hash, label).also { writeSidecar(it) }
}

internal fun writeZip(target: File, entries: Map<String, String>): File {
    ZipOutputStream(target.outputStream()).use { zip ->
        entries.forEach { (name, content) ->
            zip.putNextEntry(ZipEntry(name))
            zip.write(content.toByteArray())
            zip.closeEntry()
        }
    }
    return target
}

internal fun File.tree(): Map<String, String> = walkTopDown()
    .filter { it.isFile }
    .associate { it.relativeTo(this).invariantSeparatorsPath to it.readText() }

internal inline fun <reified T : Throwable> assertThrowsCode(code: String, block: () -> Unit): T {
    try {
        block()
    } catch (e: Throwable) {
        if (e is T && (e !is CodePushException || e.code == code)) {
            return e
        }
        throw AssertionError("Expected ${T::class.simpleName} with code $code, got $e", e)
    }
    throw AssertionError("Expected ${T::class.simpleName} with code $code, nothing was thrown")
}
