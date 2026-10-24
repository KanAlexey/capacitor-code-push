package io.github.kanalexey.codepush

import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/** A tree of files to hash: a folder on disk, or the APK's assets. */
interface FileTree {
    /** Every file under the tree, as `/`-separated paths relative to its root. */
    fun files(): List<String>

    fun open(relativePath: String): InputStream
}

class DirectoryTree(private val root: File) : FileTree {
    override fun files(): List<String> = root.walkTopDown()
        .filter { it.isFile }
        .map { it.relativeTo(root).invariantSeparatorsPath }
        .toList()

    override fun open(relativePath: String): InputStream = File(root, relativePath).inputStream()
}

/**
 * The package hash as the Revopush CLI and server compute it (DESIGN.md §11): every file as
 * `<prefix>/<path>:<sha256>`, skipping `.DS_Store` anywhere and a leading `__MACOSX/`, sorted by UTF-16 code unit,
 * then the sha256 of their `JSON.stringify`.
 */
object PackageHasher {
    fun hash(tree: FileTree, prefix: String): String {
        val entries = tree.files()
            .map { if (prefix.isEmpty()) it else "$prefix/$it" }
            .filterNot(::isIgnored)
            .map { path ->
                val name = if (prefix.isEmpty()) path else path.removePrefix("$prefix/")
                "$path:${tree.open(name).use(::sha256)}"
            }
            .sorted()
        return sha256(jsonStringify(entries).toByteArray(Charsets.UTF_8))
    }

    fun isIgnored(relativePath: String): Boolean =
        relativePath.startsWith("__MACOSX/") || relativePath == ".DS_Store" || relativePath.endsWith("/.DS_Store")

    /** `JSON.stringify` of an array of strings, byte for byte. */
    fun jsonStringify(values: List<String>): String =
        values.joinToString(separator = ",", prefix = "[", postfix = "]") { quote(it) }

    private fun quote(value: String): String {
        val out = StringBuilder(value.length + 2).append('"')
        var i = 0
        while (i < value.length) {
            val c = value[i]
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\b' -> out.append("\\b")
                c == '\u000C' -> out.append("\\f")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append(String.format("\\u%04x", c.code))
                Character.isHighSurrogate(c) && i + 1 < value.length && Character.isLowSurrogate(value[i + 1]) -> {
                    out.append(c).append(value[i + 1])
                    i++
                }
                Character.isSurrogate(c) -> out.append(String.format("\\u%04x", c.code))
                else -> out.append(c)
            }
            i++
        }
        return out.append('"').toString()
    }

    fun sha256(input: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            digest.update(buffer, 0, read)
        }
        return hex(digest.digest())
    }

    fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
