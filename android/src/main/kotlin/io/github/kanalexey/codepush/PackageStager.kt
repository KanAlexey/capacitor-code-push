package io.github.kanalexey.codepush

import org.json.JSONObject
import java.io.File
import java.util.zip.ZipInputStream

/** Where a diff starts from: a staged package's folder, or the store bundle. */
fun interface BaseSource {
    /** Copies the web root into [destination], which exists and is empty. */
    fun copyTo(destination: File)
}

object Unzipper {
    /**
     * Unzips [zip] into [destination]. An entry that is absolute or climbs out with `..` is refused: a zip from the
     * server must not write outside the folder it is unpacked in. (java.util.zip never creates a symbolic link, so a
     * link entry arrives as a plain file holding its target's path.)
     */
    fun unzip(zip: File, destination: File) {
        destination.mkdirs()
        val root = destination.canonicalFile
        try {
            ZipInputStream(zip.inputStream().buffered()).use { input ->
                while (true) {
                    val entry = input.nextEntry ?: break
                    val target = resolveInside(root, entry.name)
                    if (entry.isDirectory) {
                        target.mkdirs()
                    } else {
                        target.parentFile?.mkdirs()
                        target.outputStream().use { input.copyTo(it) }
                    }
                }
            }
        } catch (e: CodePushException) {
            throw e
        } catch (e: Exception) {
            throw CodePushException(CodePushException.INVALID_PACKAGE, "Could not unzip the package: ${e.message}", e)
        }
    }

    /** [relativePath] under [root], or INVALID_PACKAGE when it would land anywhere else. */
    fun resolveInside(root: File, relativePath: String): File {
        val normalised = relativePath.replace('\\', '/')
        val segments = normalised.split('/')
        if (normalised.startsWith("/") || segments.any { it == ".." } || Regex("^[A-Za-z]:").containsMatchIn(normalised)) {
            throw CodePushException(CodePushException.INVALID_PACKAGE, "Refused path in package: $relativePath")
        }
        val target = File(root, normalised).canonicalFile
        if (target != root && !target.path.startsWith(root.path + File.separator)) {
            throw CodePushException(CodePushException.INVALID_PACKAGE, "Refused path in package: $relativePath")
        }
        return target
    }
}

/**
 * Turns a downloaded zip into a staged package (DESIGN.md §11): unzip, apply a diff onto its base, find the web
 * root, check the hash of a diff, move the web root to `packages/<hash>/` and write the sidecar.
 */
class PackageStager(private val store: StateStore) {
    fun stage(zip: File, metadata: PackageMetadata, base: BaseSource, publicKeyConfigured: Boolean) {
        val packageHash = StateStore.checkedHash(metadata.packageHash)
        if (publicKeyConfigured) {
            throw CodePushException(
                CodePushException.SIGNATURE_UNSUPPORTED,
                "A public key is configured, and this version cannot verify signatures; refusing to install.",
            )
        }
        val unzipped = File(store.downloadDir, "unzipped").apply { deleteRecursively() }
        Unzipper.unzip(zip, unzipped)

        val diffManifest = File(unzipped, DIFF_MANIFEST)
        val releaseRoot: File
        if (diffManifest.isFile) {
            releaseRoot = applyDiff(unzipped, diffManifest, base)
            val computed = PackageHasher.hash(DirectoryTree(releaseRoot), releaseRoot.name)
            if (computed != packageHash) {
                throw CodePushException(
                    CodePushException.HASH_MISMATCH,
                    "The update contents failed the data integrity check: expected $packageHash, got $computed.",
                )
            }
        } else {
            releaseRoot = findWebRoot(unzipped)
        }
        if (File(releaseRoot, ".codepushrelease").isFile) {
            Log.warn("The update carries a signature, and no public key is configured to check it.")
        }

        val destination = store.packageDir(packageHash)
        destination.deleteRecursively()
        destination.parentFile?.mkdirs()
        if (!releaseRoot.renameTo(destination)) {
            releaseRoot.copyRecursively(destination, overwrite = true)
        }
        store.writeSidecar(metadata)
        store.downloadDir.deleteRecursively()
    }

    /** Copies the base into `merge/<release folder>`, lays the diff over it and deletes what it lists. */
    private fun applyDiff(unzipped: File, diffManifest: File, base: BaseSource): File {
        val merge = File(store.downloadDir, "merge").apply { deleteRecursively(); mkdirs() }
        val folderName = topLevelDirectories(unzipped).singleOrNull()?.name ?: "www"
        val releaseRoot = File(merge, folderName).apply { mkdirs() }
        base.copyTo(releaseRoot)

        unzipped.walkTopDown().filter { it.isFile && it != diffManifest }.forEach { file ->
            val target = Unzipper.resolveInside(merge.canonicalFile, file.relativeTo(unzipped).invariantSeparatorsPath)
            target.parentFile?.mkdirs()
            file.copyTo(target, overwrite = true)
        }

        val deleted = try {
            JSONObject(diffManifest.readText()).optJSONArray("deletedFiles")
        } catch (e: Exception) {
            throw CodePushException(CodePushException.INVALID_PACKAGE, "Unreadable $DIFF_MANIFEST: ${e.message}", e)
        }
        for (i in 0 until (deleted?.length() ?: 0)) {
            Unzipper.resolveInside(merge.canonicalFile, deleted!!.getString(i)).deleteRecursively()
        }
        if (!File(releaseRoot, "index.html").isFile) {
            throw CodePushException(CodePushException.INVALID_PACKAGE, "The update has no index.html after the diff.")
        }
        return releaseRoot
    }

    /** The single top-level folder holding `index.html`, else the unzipped folder itself when it holds one. */
    private fun findWebRoot(unzipped: File): File {
        val candidates = topLevelDirectories(unzipped).filter { File(it, "index.html").isFile }
        return when {
            candidates.size == 1 -> candidates.single()
            File(unzipped, "index.html").isFile -> unzipped
            else -> throw CodePushException(CodePushException.INVALID_PACKAGE, "The update has no index.html.")
        }
    }

    private fun topLevelDirectories(folder: File): List<File> =
        folder.listFiles()?.filter { it.isDirectory && it.name != "__MACOSX" }.orEmpty()

    companion object {
        const val DIFF_MANIFEST = "hotcodepush.json"
    }
}
