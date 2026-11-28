package dev.hatch.app.core

import java.io.File
import java.util.UUID

/**
 * What Apps saved on this device for one instance (`<instance>/storage`),
 * forgotten when the instance's account signs out so the next account there
 * finds none of it. Until the storage is gone, it is not used again: a
 * deletion that fails stays pending, on disk (a marker) and in this process
 * (in case the marker could not be written either).
 */
object AppStorage {
    private const val PENDING = "storage-forget-pending"
    private const val FORGOTTEN = "storage-forgotten-"
    private val pending = mutableSetOf<String>()

    /** Deletes the instance's App storage; false when some of it is still there. */
    @Synchronized
    fun forget(instanceDirectory: File): Boolean {
        pending += instanceDirectory.path
        runCatching {
            instanceDirectory.mkdirs()
            File(instanceDirectory, PENDING).writeText("")
        }
        return clear(instanceDirectory)
    }

    /** Whether the instance's App storage may be used, finishing a deletion left pending. */
    @Synchronized
    fun ready(instanceDirectory: File): Boolean {
        if (instanceDirectory.path in pending || File(instanceDirectory, PENDING).exists()) {
            return clear(instanceDirectory)
        }
        sweep(instanceDirectory)
        return true
    }

    private fun clear(instanceDirectory: File): Boolean {
        val storage = File(instanceDirectory, "storage")
        // Out of the way first, in one step: nothing reads it there even if
        // deleting it fails.
        if (storage.exists() && !storage.renameTo(File(instanceDirectory, "$FORGOTTEN${UUID.randomUUID()}"))) {
            storage.deleteRecursively()
        }
        if (storage.exists()) return false
        sweep(instanceDirectory)
        File(instanceDirectory, PENDING).delete()
        pending -= instanceDirectory.path
        return true
    }

    private fun sweep(instanceDirectory: File) {
        instanceDirectory.listFiles { file -> file.name.startsWith(FORGOTTEN) }?.forEach { it.deleteRecursively() }
    }
}
