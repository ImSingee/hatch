package dev.hatch.app.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class AppStorageTest {
    private val instance = kotlin.io.path.createTempDirectory().toFile()

    private fun save(account: String): File =
        File(AppStorage.accountDirectory(instance, account), "storage/app-1").apply {
            mkdirs()
            File(this, "draft").writeText("an unsent form")
        }

    @Test
    fun anAccountNeverOpensWhatAnotherSaved() {
        val first = save("account-a")
        // Whatever happens to the first account's data, the next account's
        // Apps look elsewhere.
        assertNotEquals(first.canonicalPath, File(AppStorage.accountDirectory(instance, "account-b"), "storage/app-1").canonicalPath)
    }

    @Test
    fun signingOutDeletesWhatAppsSaved() {
        save("account-a")
        save("account-b")
        assertEquals(true, AppStorage.forget(instance))
        assertEquals(listOf(), instance.list()!!.toList())
        // Nothing saved: nothing to delete.
        assertEquals(true, AppStorage.forget(instance))
    }
}
