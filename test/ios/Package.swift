// swift-tools-version: 5.9
// The plugin's core under XCTest: on the macOS host with coverage (`npm run test:ios:coverage`, what CI runs), or on an iOS
// simulator (`npm run test:ios`). Sources/CodePushCore is a link to ios/Sources/CodePushCore, so the tests build what the
// plugin ships, and the tests stay out of the npm package.
import PackageDescription

let package = Package(
    name: "CodePushCoreTests",
    platforms: [.iOS(.v15), .macOS(.v12)],
    dependencies: [
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19")
    ],
    targets: [
        .target(
            name: "CodePushCore",
            dependencies: [.product(name: "ZIPFoundation", package: "ZIPFoundation")],
            path: "Sources/CodePushCore"),
        .testTarget(
            name: "CodePushCoreTests",
            dependencies: ["CodePushCore", .product(name: "ZIPFoundation", package: "ZIPFoundation")],
            path: "Tests")
    ]
)
