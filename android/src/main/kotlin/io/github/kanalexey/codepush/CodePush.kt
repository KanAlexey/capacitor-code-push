package io.github.kanalexey.codepush

import com.getcapacitor.Logger

class CodePush {

    fun echo(value: String): String {
        Logger.info("Echo", value)

        return value
    }
}
