package dev.hatch.app.core

import java.io.File

/**
 * What Apps saved on this device for one instance (`<instance>/storage`),
 * forgotten when the instance's account signs out so the next account there
 * finds none of it. A deletion that fails is not forgotten: a marker stays
 * until it succeeds, and the storage is not used again before then.
 */
object AppStorage {
    private const val PENDING = "storage-forget-pending"

    /** Deletes the instance's App storage; false when some of it is still there. */
    fun forget(instanceDirectory: File): Boolean {
        instanceDirectory.mkdirs()
        File(instanceDirectory, PENDING).writeText("")
        return clear(instanceDirectory)
    }

    /** Whether the instance's App storage may be used, finishing a deletion left pending. */
    fun ready(instanceDirectory: File): Boolean =
        !File(instanceDirectory, PENDING).exists() || clear(instanceDirectory)

    private fun clear(instanceDirectory: File): Boolean {
        val storage = File(instanceDirectory, "storage")
        if (storage.exists() && !storage.deleteRecursively()) return false
        return File(instanceDirectory, PENDING).delete()
    }
}
