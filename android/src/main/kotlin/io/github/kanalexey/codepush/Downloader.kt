package io.github.kanalexey.codepush

import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Streams a package to a file. HTTPS only unless [allowInsecure] (a local test server); redirects are followed by
 * hand, at most [MAX_REDIRECTS], because HttpURLConnection will not follow one across protocols and one from HTTPS
 * to HTTP must be refused anyway.
 */
class Downloader(
    private val allowInsecure: Boolean,
    private val connect: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    /** [onProgress] gets the bytes so far and the total, at most every [PROGRESS_STEP] bytes and once at the end. */
    fun download(url: String, destination: File, expectedSize: Long, onProgress: (received: Long, total: Long) -> Unit) {
        var location = parse(url)
        checkScheme(location, previous = null)
        var redirects = 0
        while (true) {
            val connection = connect(location)
            try {
                connection.instanceFollowRedirects = false
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                val status = connection.responseCode
                if (status in REDIRECTS) {
                    val next = connection.getHeaderField("Location")
                        ?: throw failure("Redirect $status without a Location from $location")
                    if (++redirects > MAX_REDIRECTS) {
                        throw failure("Too many redirects downloading $url")
                    }
                    val target = URL(location, next)
                    checkScheme(target, previous = location)
                    location = target
                    continue
                }
                if (status != HttpURLConnection.HTTP_OK) {
                    throw failure("HTTP $status downloading $location")
                }
                val length = connection.contentLengthLong
                val total = if (length > 0) length else expectedSize
                destination.parentFile?.mkdirs()
                var received = 0L
                var reported = 0L
                connection.inputStream.use { input ->
                    destination.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            output.write(buffer, 0, read)
                            received += read
                            if (received - reported >= PROGRESS_STEP) {
                                reported = received
                                onProgress(received, maxOf(total, received))
                            }
                        }
                    }
                }
                onProgress(received, maxOf(total, received))
                return
            } catch (e: CodePushException) {
                throw e
            } catch (e: IOException) {
                throw CodePushException(CodePushException.DOWNLOAD_FAILED, "Download failed: ${e.message}", e)
            } finally {
                connection.disconnect()
            }
        }
    }

    private fun parse(url: String): URL = try {
        URL(url)
    } catch (e: Exception) {
        throw CodePushException(CodePushException.INVALID_ARGUMENT, "Invalid download URL: $url", e)
    }

    private fun checkScheme(target: URL, previous: URL?) {
        val scheme = target.protocol.lowercase()
        if (scheme != "https" && scheme != "http") {
            throw CodePushException(CodePushException.INVALID_ARGUMENT, "Unsupported download URL: $target")
        }
        if (scheme == "http" && previous?.protocol.equals("https", ignoreCase = true)) {
            throw failure("Refused a redirect from HTTPS to HTTP: $target")
        }
        if (scheme == "http" && !allowInsecure) {
            throw CodePushException(
                CodePushException.INVALID_ARGUMENT,
                "Refused an HTTP download (set plugins.CodePush.allowInsecureDownloads for a local server): $target",
            )
        }
    }

    private fun failure(message: String) = CodePushException(CodePushException.DOWNLOAD_FAILED, message)

    companion object {
        const val MAX_REDIRECTS = 5
        const val PROGRESS_STEP = 64 * 1024L
        private const val TIMEOUT_MS = 30_000
        private val REDIRECTS = setOf(301, 302, 303, 307, 308)
    }
}
