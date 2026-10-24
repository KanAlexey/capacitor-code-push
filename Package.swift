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
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "CodePushPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/CodePushPlugin"),
        .testTarget(
            name: "CodePushPluginTests",
            dependencies: ["CodePushPlugin"],
            path: "ios/Tests/CodePushPluginTests")
    ]
)