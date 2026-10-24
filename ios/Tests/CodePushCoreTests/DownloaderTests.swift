import XCTest
@testable import CodePushCore

/// Answers requests from a table instead of the network, redirects included.
final class StubProtocol: URLProtocol {
    struct Answer {
        var status: Int
        var headers: [String: String] = [:]
        var body = Data()
    }

    static var answers: [String: Answer] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let answer = Self.answers[url.absoluteString] else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
                                       headerFields: answer.headers)!
        if (300..<400).contains(answer.status), let location = answer.headers["Location"],
           let target = URL(string: location, relativeTo: url) {
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target.absoluteURL), redirectResponse: response)
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: answer.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class DownloaderTests: TemporaryFolderTestCase {
    let body = Data((0..<(200 * 1024)).map { UInt8($0 % 251) })

    func downloader(allowInsecure: Bool = false) -> Downloader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return Downloader(allowInsecure: allowInsecure, configuration: configuration)
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        StubProtocol.answers = [
            "https://cdn.example.com/package.zip": .init(status: 200, headers: ["Content-Length": "\(body.count)"], body: body),
            "https://updates.example.com/redirect": .init(status: 302, headers: ["Location": "https://cdn.example.com/package.zip"]),
            "https://updates.example.com/downgrade": .init(status: 302, headers: ["Location": "http://cdn.example.com/package.zip"]),
            "https://updates.example.com/loop": .init(status: 302, headers: ["Location": "https://updates.example.com/loop"]),
            "https://updates.example.com/missing": .init(status: 404)
        ]
    }

    override func tearDownWithError() throws {
        StubProtocol.answers = [:]
        try super.tearDownWithError()
    }

    func testStreamsThePackageAndEndsAtTheTotal() throws {
        let target = temporary.appendingPathComponent("update.zip")
        var events: [(Int64, Int64)] = []

        try downloader().download(url: "https://cdn.example.com/package.zip", to: target, expectedSize: 0) { events.append(($0, $1)) }

        XCTAssertEqual(try Data(contentsOf: target), body)
        XCTAssertEqual(events.last?.0, Int64(body.count))
        XCTAssertEqual(events.last?.1, Int64(body.count))
    }

    func testFollowsARedirect() throws {
        let target = temporary.appendingPathComponent("update.zip")

        try downloader().download(url: "https://updates.example.com/redirect", to: target, expectedSize: 0) { _, _ in }

        XCTAssertEqual(try Data(contentsOf: target), body)
    }

    func testRefusesARedirectFromHTTPSToHTTPEvenWhenHTTPIsAllowed() {
        XCTAssertThrowsCode(CodePushError.downloadFailed) {
            try self.downloader(allowInsecure: true).download(url: "https://updates.example.com/downgrade",
                                                              to: self.temporary.appendingPathComponent("u.zip"),
                                                              expectedSize: 0) { _, _ in }
        }
    }

    func testGivesUpAfterTooManyRedirects() {
        XCTAssertThrowsCode(CodePushError.downloadFailed) {
            try self.downloader().download(url: "https://updates.example.com/loop",
                                           to: self.temporary.appendingPathComponent("u.zip"), expectedSize: 0) { _, _ in }
        }
    }

    func testFailsOnAnErrorStatus() {
        XCTAssertThrowsCode(CodePushError.downloadFailed) {
            try self.downloader().download(url: "https://updates.example.com/missing",
                                           to: self.temporary.appendingPathComponent("u.zip"), expectedSize: 0) { _, _ in }
        }
    }

    func testRefusesPlainHTTPUnlessAllowed() {
        XCTAssertThrowsCode(CodePushError.invalidArgument) {
            try self.downloader().download(url: "http://cdn.example.com/package.zip",
                                           to: self.temporary.appendingPathComponent("u.zip"), expectedSize: 0) { _, _ in }
        }
    }

    func testAnUnreachableHostIsADownloadFailure() {
        XCTAssertThrowsCode(CodePushError.downloadFailed) {
            try self.downloader().download(url: "https://nowhere.example.com/x.zip",
                                           to: self.temporary.appendingPathComponent("u.zip"), expectedSize: 0) { _, _ in }
        }
    }
}
