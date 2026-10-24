package io.github.kanalexey.codepush

/**
 * Logging that works on the device and in JVM tests alike: the core classes call this instead of
 * `android.util.Log`, whose stubs throw in a unit test, and the plugin points it at Capacitor's logger.
 */
object Log {
    @Volatile
    var sink: (level: String, message: String) -> Unit = { level, message -> println("[CodePush] $level $message") }

    fun info(message: String) = sink("I", message)

    fun warn(message: String) = sink("W", message)
}
