package io.github.kanalexey.codepush

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread
import java.net.URL

class DownloaderTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private lateinit var server: TinyServer
    private val body = ByteArray(200 * 1024) { (it % 251).toByte() }

    @Before
    fun setUp() {
        server = TinyServer { path ->
            when (path) {
                "/package.zip" -> Response(200, body = body, length = true)
                "/chunked.zip" -> Response(200, body = body, length = false)
                "/redirect" -> Response(302, headers = mapOf("Location" to "/package.zip"))
                "/loop" -> Response(302, headers = mapOf("Location" to "/loop"))
                else -> Response(404)
            }
        }
    }

    @After
    fun tearDown() = server.close()

    private fun url(path: String) = "http://127.0.0.1:${server.port}$path"

    @Test
    fun `streams the package and reports progress up to the total`() {
        val target = temporary.root.resolve("update.zip")
        val events = mutableListOf<Pair<Long, Long>>()

        Downloader(allowInsecure = true).download(url("/package.zip"), target, 0) { r, t -> events += r to t }

        assertTrue(target.readBytes().contentEquals(body))
        assertEquals(body.size.toLong() to body.size.toLong(), events.last())
        assertTrue("at most one event per 64 KiB, plus the last", events.size <= body.size / (64 * 1024) + 1)
        assertTrue(events.zipWithNext().all { (a, b) -> a.first <= b.first })
    }

    @Test
    fun `falls back to the announced size when the server sends no length`() {
        val events = mutableListOf<Pair<Long, Long>>()

        Downloader(allowInsecure = true)
            .download(url("/chunked.zip"), temporary.root.resolve("u.zip"), 300 * 1024L) { r, t -> events += r to t }

        assertEquals(300 * 1024L, events.first().second)
        assertEquals(body.size.toLong(), events.last().first)
    }

    @Test
    fun `follows a redirect`() {
        val target = temporary.root.resolve("update.zip")

        Downloader(allowInsecure = true).download(url("/redirect"), target, 0) { _, _ -> }

        assertTrue(target.readBytes().contentEquals(body))
    }

    @Test
    fun `gives up after too many redirects`() {
        assertThrowsCode<CodePushException>(CodePushException.DOWNLOAD_FAILED) {
            Downloader(allowInsecure = true).download(url("/loop"), temporary.root.resolve("u.zip"), 0) { _, _ -> }
        }
    }

    @Test
    fun `fails on an error status`() {
        assertThrowsCode<CodePushException>(CodePushException.DOWNLOAD_FAILED) {
            Downloader(allowInsecure = true).download(url("/missing"), temporary.root.resolve("u.zip"), 0) { _, _ -> }
        }
    }

    @Test
    fun `refuses plain HTTP unless allowed`() {
        assertThrowsCode<CodePushException>(CodePushException.INVALID_ARGUMENT) {
            Downloader(allowInsecure = false).download(url("/package.zip"), temporary.root.resolve("u.zip"), 0) { _, _ -> }
        }
    }

    @Test
    fun `refuses a redirect from HTTPS to HTTP even when HTTP is allowed`() {
        val downloader = Downloader(allowInsecure = true) { target ->
            FakeConnection(target, 302, mapOf("Location" to "http://cdn.example.com/package.zip"))
        }

        assertThrowsCode<CodePushException>(CodePushException.DOWNLOAD_FAILED) {
            downloader.download("https://updates.example.com/package.zip", temporary.root.resolve("u.zip"), 0) { _, _ -> }
        }
    }

    @Test
    fun `a dropped connection is a download failure`() {
        val downloader = Downloader(allowInsecure = false) { target ->
            object : FakeConnection(target, 200, emptyMap()) {
                override fun getInputStream(): InputStream = throw java.io.IOException("reset")
            }
        }

        assertThrowsCode<CodePushException>(CodePushException.DOWNLOAD_FAILED) {
            downloader.download("https://updates.example.com/package.zip", temporary.root.resolve("u.zip"), 0) { _, _ -> }
        }
    }

    private open class FakeConnection(
        url: URL,
        private val status: Int,
        private val headers: Map<String, String>,
    ) : HttpURLConnection(url) {
        override fun getResponseCode() = status
        override fun getHeaderField(name: String?): String? = headers[name]
        override fun getInputStream(): InputStream = ByteArrayInputStream(ByteArray(0))
        override fun getContentLengthLong() = -1L
        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy() = false
    }

    private class Response(
        val status: Int,
        val headers: Map<String, String> = emptyMap(),
        val body: ByteArray = ByteArray(0),
        val length: Boolean = true,
    )

    /**
     * Just enough HTTP/1.1 for these tests: one request per connection, a fixed length or a body closed by EOF.
     * (com.sun.net.httpserver is not on an Android module's test compile path.)
     */
    private class TinyServer(private val route: (String) -> Response) : AutoCloseable {
        private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val port: Int get() = socket.localPort

        init {
            thread(isDaemon = true) {
                while (!socket.isClosed) {
                    val client = try {
                        socket.accept()
                    } catch (e: java.io.IOException) {
                        break
                    }
                    client.use { connection ->
                        val reader = connection.getInputStream().bufferedReader()
                        val path = reader.readLine()?.split(" ")?.getOrNull(1) ?: return@use
                        while (reader.readLine()?.isNotEmpty() == true) Unit
                        val response = route(path)
                        val head = StringBuilder("HTTP/1.1 ${response.status} X\r\nConnection: close\r\n")
                        response.headers.forEach { (name, value) -> head.append("$name: $value\r\n") }
                        if (response.length) head.append("Content-Length: ${response.body.size}\r\n")
                        head.append("\r\n")
                        connection.getOutputStream().apply {
                            write(head.toString().toByteArray())
                            write(response.body)
                            flush()
                        }
                    }
                }
            }
        }

        override fun close() = socket.close()
    }
}
