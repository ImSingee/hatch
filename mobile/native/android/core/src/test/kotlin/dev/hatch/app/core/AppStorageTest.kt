package dev.hatch.app.core

import java.io.File
import kotlin.test.Test
import org.junit.Assume.assumeTrue
import kotlin.test.assertEquals

class AppStorageTest {
    private val instance = kotlin.io.path.createTempDirectory().toFile()
    private val storage = File(instance, "storage/app-1")

    @Test
    fun signingOutDeletesWhatAppsSaved() {
        storage.mkdirs()
        File(storage, "draft").writeText("an unsent form")
        assertEquals(true, AppStorage.forget(instance))
        assertEquals(false, File(instance, "storage").exists())
        assertEquals(true, AppStorage.ready(instance))
    }

    @Test
    fun aDeletionThatFailedKeepsTheStorageFromUseUntilItSucceeds() {
        // Permissions are how the deletion is made to fail; root ignores them.
        assumeTrue(System.getProperty("user.name") != "root")
        storage.mkdirs()
        File(storage, "draft").writeText("an unsent form")
        storage.setWritable(false)
        try {
            assertEquals(false, AppStorage.forget(instance))
            // The next session for this instance may not use it yet.
            assertEquals(false, AppStorage.ready(instance))
        } finally {
            storage.setWritable(true)
        }
        // Once the deletion can finish, the next session finishes it first.
        assertEquals(true, AppStorage.ready(instance))
        assertEquals(false, File(instance, "storage").exists())
        assertEquals(true, AppStorage.ready(instance))
    }
}
