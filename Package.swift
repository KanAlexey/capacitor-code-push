// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorCodePush",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorCodePush",
            targets: ["CodePushPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/weichsel/ZIPFoundation.git", from: "0.9.19")
    ],
    targets: [
        // The state machine, staging and downloads: Foundation only, so XCTest reaches it without a bridge.
        .target(
            name: "CodePushCore",
            dependencies: [
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Sources/CodePushCore"),
        .target(
            name: "CodePushPlugin",
            dependencies: [
                "CodePushCore",
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CodePushPlugin"),
        .testTarget(
            name: "CodePushCoreTests",
            dependencies: [
                "CodePushCore",
                .product(name: "ZIPFoundation", package: "ZIPFoundation")
            ],
            path: "ios/Tests/CodePushCoreTests")
    ]
)
