import Foundation

/// Streams a package to a file. HTTPS only unless `allowInsecure` (a local test server); at most `maxRedirects`
/// redirects, and never one from HTTPS to HTTP. Blocking: call it off the main thread.
public final class Downloader: NSObject, URLSessionDownloadDelegate {
    public static let maxRedirects = 5
    public static let progressStep: Int64 = 64 * 1024

    private let allowInsecure: Bool
    private let configuration: URLSessionConfiguration

    private var destination: URL!
    private var expectedSize: Int64 = 0
    private var onProgress: ((Int64, Int64) -> Void)?
    private var redirects = 0
    private var reported: Int64 = 0
    private var failure: Error?
    private var finished = DispatchSemaphore(value: 0)

    /// `configuration` lets a test route requests through its own URLProtocol.
    public init(allowInsecure: Bool, configuration: URLSessionConfiguration = .default) {
        self.allowInsecure = allowInsecure
        self.configuration = configuration
        configuration.timeoutIntervalForRequest = 30
    }

    /// `onProgress` gets the bytes so far and the total, at most every `progressStep` bytes and once at the end.
    public func download(url: String, to destination: URL, expectedSize: Int64,
                         onProgress: @escaping (Int64, Int64) -> Void) throws {
        guard let source = URL(string: url) else {
            throw CodePushError(CodePushError.invalidArgument, "Invalid download URL: \(url)")
        }
        try checkScheme(source, previous: nil)
        self.destination = destination
        self.expectedSize = expectedSize
        self.onProgress = onProgress
        redirects = 0
        reported = 0
        failure = nil
        finished = DispatchSemaphore(value: 0)
        try? FileManager.default.createDirectory(at: destination.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)

        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        session.downloadTask(with: source).resume()
        finished.wait()
        session.finishTasksAndInvalidate()
        if let failure { throw failure }
    }

    private func checkScheme(_ target: URL, previous: URL?) throws {
        let scheme = target.scheme?.lowercased() ?? ""
        guard scheme == "https" || scheme == "http" else {
            throw CodePushError(CodePushError.invalidArgument, "Unsupported download URL: \(target)")
        }
        if scheme == "http", previous?.scheme?.lowercased() == "https" {
            throw CodePushError(CodePushError.downloadFailed, "Refused a redirect from HTTPS to HTTP: \(target)")
        }
        if scheme == "http", !allowInsecure {
            throw CodePushError(CodePushError.invalidArgument,
                                "Refused an HTTP download (set plugins.CodePush.allowInsecureDownloads for a local server): \(target)")
        }
    }

    private func total(_ expected: Int64, _ received: Int64) -> Int64 {
        max(expected > 0 ? expected : expectedSize, received)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        do {
            guard redirects <= Self.maxRedirects, let target = request.url else {
                throw CodePushError(CodePushError.downloadFailed, "Too many redirects downloading \(task.originalRequest?.url?.absoluteString ?? "")")
            }
            try checkScheme(target, previous: response.url)
            completionHandler(request)
        } catch {
            failure = error
            completionHandler(nil)
            task.cancel()
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                           totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesWritten - reported >= Self.progressStep {
            reported = totalBytesWritten
            onProgress?(totalBytesWritten, total(totalBytesExpectedToWrite, totalBytesWritten))
        }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard failure == nil else { return }
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            failure = CodePushError(CodePushError.downloadFailed,
                                    "HTTP \(status) downloading \(downloadTask.currentRequest?.url?.absoluteString ?? "")")
            return
        }
        do {
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            let size = (try? FileManager.default.attributesOfItem(atPath: destination.path)[.size] as? NSNumber)?.int64Value ?? 0
            onProgress?(size, total(downloadTask.countOfBytesExpectedToReceive, size))
        } catch {
            failure = CodePushError(CodePushError.downloadFailed, "Could not keep the download: \(error)")
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil, let error {
            failure = CodePushError(CodePushError.downloadFailed, "Download failed: \(error.localizedDescription)")
        }
        finished.signal()
    }
}
