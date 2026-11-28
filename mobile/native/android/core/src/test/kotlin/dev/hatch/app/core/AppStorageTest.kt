package dev.hatch.app.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.Assume.assumeTrue

class AppStorageTest {
    private val instance = kotlin.io.path.createTempDirectory().toFile()
    private val storage = File(instance, "storage/app-1")

    init {
        storage.mkdirs()
        File(storage, "draft").writeText("an unsent form")
    }

    @Test
    fun signingOutDeletesWhatAppsSaved() {
        assertEquals(true, AppStorage.forget(instance))
        assertEquals(false, File(instance, "storage").exists())
        assertEquals(true, AppStorage.ready(instance))
        assertEquals(listOf(), instance.list()!!.toList())
    }

    @Test
    fun aDeletionThatFailedKeepsTheStorageFromUseUntilItSucceeds() {
        // Permissions are how the deletion is made to fail; root ignores them.
        assumeTrue(System.getProperty("user.name") != "root")
        // The instance directory refuses changes: neither the marker nor
        // moving or removing the storage can happen.
        instance.setWritable(false)
        try {
            assertEquals(false, AppStorage.forget(instance))
            // The next session for this instance (signing in again) may not use it.
            assertEquals(false, AppStorage.ready(instance))
        } finally {
            instance.setWritable(true)
        }
        // Once the deletion can finish, the next session finishes it first.
        assertEquals(true, AppStorage.ready(instance))
        assertEquals(false, File(instance, "storage").exists())
        assertEquals(true, AppStorage.ready(instance))
    }
}
