package io.github.kanalexey.codepush

import org.json.JSONObject
import java.io.File

/**
 * The plugin's folder: `state.json`, staged packages under `packages/` (a web root per hash plus a `<hash>.json`
 * sidecar), and `download/` as scratch.
 */
class StateStore(val root: File) {
    val packagesDir = File(root, "packages")
    val downloadDir = File(root, "download")
    private val stateFile = File(root, "state.json")

    /** The stored state; an absent or unreadable file reads as empty, which serves the store bundle. */
    fun read(): CodePushState {
        if (!stateFile.isFile) {
            return CodePushState()
        }
        return try {
            CodePushState.fromJson(JSONObject(stateFile.readText()))
        } catch (e: Exception) {
            Log.warn("Unreadable state.json, starting from the store bundle: ${e.message}")
            CodePushState()
        }
    }

    fun exists(): Boolean = stateFile.isFile

    /** Writes through a temporary file and a rename, so a crash leaves the old state or the new one. */
    fun write(state: CodePushState) {
        root.mkdirs()
        val temporary = File(root, "state.json.tmp")
        temporary.writeText(state.toJson().toString())
        if (!temporary.renameTo(stateFile)) {
            stateFile.delete()
            if (!temporary.renameTo(stateFile)) {
                throw java.io.IOException("Could not replace ${stateFile.path}")
            }
        }
    }

    fun packageDir(packageHash: String): File = File(packagesDir, checkedHash(packageHash))

    private fun sidecar(packageHash: String): File = File(packagesDir, "${checkedHash(packageHash)}.json")

    /** A staged package is usable when its web root still holds `index.html`. */
    fun isStaged(packageHash: String): Boolean =
        File(packageDir(packageHash), "index.html").isFile && sidecar(packageHash).isFile

    fun readSidecar(packageHash: String): PackageMetadata? = try {
        PackageMetadata.fromJson(JSONObject(sidecar(packageHash).readText()))
    } catch (e: Exception) {
        null
    }

    fun writeSidecar(metadata: PackageMetadata) {
        packagesDir.mkdirs()
        sidecar(metadata.packageHash).writeText(metadata.toJson().toString())
    }

    fun deletePackage(packageHash: String) {
        packageDir(packageHash).deleteRecursively()
        sidecar(packageHash).delete()
    }

    /** Deletes every staged package not named in [keep]. */
    fun deletePackagesExcept(keep: Set<String>) {
        packagesDir.listFiles()?.forEach { file ->
            val hash = file.name.removeSuffix(".json")
            if (hash !in keep) {
                file.deleteRecursively()
            }
        }
    }

    fun deleteAllPackages() {
        packagesDir.deleteRecursively()
    }

    companion object {
        private val HASH = Regex("^[A-Za-z0-9_-]{1,128}$")

        /** A package hash names a folder, so it must not be able to name anything else. */
        fun checkedHash(packageHash: String): String {
            if (!HASH.matches(packageHash)) {
                throw CodePushException(CodePushException.INVALID_ARGUMENT, "Invalid package hash: $packageHash")
            }
            return packageHash
        }
    }
}
