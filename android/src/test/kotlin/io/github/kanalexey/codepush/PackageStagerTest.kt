package io.github.kanalexey.codepush

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class PackageStagerTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var store: StateStore
    private lateinit var stager: PackageStager
    private val noBase = BaseSource { throw AssertionError("a full package needs no base") }

    @Before
    fun setUp() {
        store = StateStore(File(temporary.root, "capacitor-codepush"))
        stager = PackageStager(store)
    }

    private fun zip(entries: Map<String, String>) = writeZip(temporary.newFile(), entries)

    /** The hash a release of [files], under a folder named [folder], has on the server. */
    private fun releaseHash(files: Map<String, String>, folder: String = "www"): String {
        val root = File(temporary.newFolder(), folder)
        files.forEach { (path, content) -> File(root, path).apply { parentFile?.mkdirs() }.writeText(content) }
        return PackageHasher.hash(DirectoryTree(root), folder)
    }

    @Test
    fun `a full release of a www folder is staged with index html at the package root`() {
        val pkg = metadata("h1")

        stager.stage(zip(mapOf("www/index.html" to "i", "www/js/main.js" to "m")), pkg, noBase, false)

        assertEquals(mapOf("index.html" to "i", "js/main.js" to "m"), store.packageDir("h1").tree())
        assertEquals(pkg, store.readSidecar("h1"))
        assertTrue(store.isStaged("h1"))
        assertFalse("scratch is cleared", store.downloadDir.exists())
    }

    @Test
    fun `a zip with index html at its root is staged as it is`() {
        stager.stage(zip(mapOf("index.html" to "i")), metadata("h1"), noBase, false)

        assertEquals(mapOf("index.html" to "i"), store.packageDir("h1").tree())
    }

    @Test
    fun `a full release is not hashed, as in cordova-plugin-code-push`() {
        stager.stage(zip(mapOf("www/index.html" to "i")), metadata("not-its-hash"), noBase, false)

        assertTrue(store.isStaged("not-its-hash"))
    }

    @Test
    fun `a release without index html is refused`() {
        assertThrowsCode<CodePushException>(CodePushException.INVALID_PACKAGE) {
            stager.stage(zip(mapOf("www/main.js" to "m")), metadata("h1"), noBase, false)
        }
        assertFalse(store.packageDir("h1").exists())
    }

    @Test
    fun `an entry climbing out of the folder is refused`() {
        assertThrowsCode<CodePushException>(CodePushException.INVALID_PACKAGE) {
            stager.stage(zip(mapOf("www/index.html" to "i", "www/../../evil.js" to "x")), metadata("h1"), noBase, false)
        }
        assertFalse(File(temporary.root, "evil.js").exists())
    }

    @Test
    fun `an absolute entry is refused`() {
        assertThrowsCode<CodePushException>(CodePushException.INVALID_PACKAGE) {
            Unzipper.resolveInside(temporary.root, "/etc/passwd")
        }
        assertThrowsCode<CodePushException>(CodePushException.INVALID_PACKAGE) {
            Unzipper.resolveInside(temporary.root, "C:/Windows/x")
        }
    }

    @Test
    fun `a configured public key refuses every package`() {
        assertThrowsCode<CodePushException>(CodePushException.SIGNATURE_UNSUPPORTED) {
            stager.stage(zip(mapOf("www/index.html" to "i")), metadata("h1"), noBase, true)
        }
    }

    @Test
    fun `a diff is laid over its base, deletes what it lists, and must match the announced hash`() {
        val base = BaseSource { destination ->
            File(destination, "index.html").writeText("old index")
            File(destination, "js").mkdirs()
            File(destination, "js/keep.js").writeText("keep")
            File(destination, "js/old.js").writeText("old")
        }
        val expected = mapOf("index.html" to "new index", "js/keep.js" to "keep", "js/new.js" to "new")
        val hash = releaseHash(expected)

        stager.stage(
            zip(
                mapOf(
                    "www/index.html" to "new index",
                    "www/js/new.js" to "new",
                    "hotcodepush.json" to """{"deletedFiles":["www/js/old.js"]}""",
                ),
            ),
            metadata(hash),
            base,
            false,
        )

        assertEquals(expected, store.packageDir(hash).tree())
    }

    @Test
    fun `a diff that only deletes still lands in a www folder`() {
        val base = BaseSource { destination ->
            File(destination, "index.html").writeText("i")
            File(destination, "gone.js").writeText("g")
        }
        val hash = releaseHash(mapOf("index.html" to "i"))

        stager.stage(zip(mapOf("hotcodepush.json" to """{"deletedFiles":["www/gone.js"]}""")), metadata(hash), base, false)

        assertEquals(mapOf("index.html" to "i"), store.packageDir(hash).tree())
    }

    @Test
    fun `a diff whose result does not match the hash is refused and not staged`() {
        val base = BaseSource { destination -> File(destination, "index.html").writeText("i") }

        assertThrowsCode<CodePushException>(CodePushException.HASH_MISMATCH) {
            stager.stage(
                zip(mapOf("www/a.js" to "a", "hotcodepush.json" to """{"deletedFiles":[]}""")),
                metadata("wrong"),
                base,
                false,
            )
        }
        assertFalse(store.isStaged("wrong"))
    }

    @Test
    fun `a diff deleting outside its folder is refused`() {
        val base = BaseSource { destination -> File(destination, "index.html").writeText("i") }

        assertThrowsCode<CodePushException>(CodePushException.INVALID_PACKAGE) {
            stager.stage(
                zip(mapOf("hotcodepush.json" to """{"deletedFiles":["../../state.json"]}""")),
                metadata("h1"),
                base,
                false,
            )
        }
    }

    @Test
    fun `a hash that could name another folder is refused before anything is written`() {
        assertThrowsCode<CodePushException>(CodePushException.INVALID_ARGUMENT) {
            stager.stage(zip(mapOf("www/index.html" to "i")), metadata("../escape"), noBase, false)
        }
    }
}
