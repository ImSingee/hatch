package dev.hatch.app.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import org.junit.Assume.assumeTrue

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
    fun aDeletionThatFailedLeavesNothingTheNextAccountOpens() {
        // Permissions are how the deletion is made to fail; root ignores them.
        assumeTrue(System.getProperty("user.name") != "root")
        val first = save("account-a")
        first.setWritable(false)
        instance.setWritable(false)
        try {
            assertEquals(false, AppStorage.forget(instance))
            assertEquals(true, File(first, "draft").exists())
            // After a restart (AppStorage keeps nothing in memory) another
            // account signs in: its Apps open their own, empty storage.
            val next = File(AppStorage.accountDirectory(instance, "account-b"), "storage/app-1")
            assertEquals(false, next.exists())
            assertEquals(false, next.canonicalPath.startsWith(first.canonicalPath))
        } finally {
            instance.setWritable(true)
            first.setWritable(true)
        }
        assertEquals(true, AppStorage.forget(instance))
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
