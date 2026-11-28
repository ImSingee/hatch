package dev.hatch.app.core

import java.io.File
import java.security.MessageDigest
import java.util.UUID

/**
 * What Apps save on this device: per instance, then per account
 * (`<instance>/accounts/<account key>/storage/<App id>`), so an account never
 * opens what another one saved, even if deleting it failed. Signing out
 * deletes every account's App storage for the instance.
 */
object AppStorage {
    private const val ACCOUNTS = "accounts"
    private const val FORGOTTEN = "accounts-forgotten-"

    /** Where `account`'s Apps keep their storage on this instance. */
    fun accountDirectory(instanceDirectory: File, accountKey: String): File =
        File(instanceDirectory, "$ACCOUNTS/$accountKey")

    /** A directory name for an account id (SHA-256, hex): any id, never a path. */
    fun accountKey(accountId: String): String =
        MessageDigest.getInstance("SHA-256").digest(accountId.toByteArray()).joinToString("") { "%02x".format(it) }

    /** Deletes what Apps saved for the instance; false when some of it is still there. */
    @Synchronized
    fun forget(instanceDirectory: File): Boolean {
        if (!instanceDirectory.exists()) return true
        val accounts = File(instanceDirectory, ACCOUNTS)
        // Out of the way first, in one step, then deleted.
        if (accounts.exists() && !accounts.renameTo(File(instanceDirectory, "$FORGOTTEN${UUID.randomUUID()}"))) {
            accounts.deleteRecursively()
        }
        // A directory it cannot list may still hold what it moved away.
        val forgotten = instanceDirectory.listFiles { file -> file.name.startsWith(FORGOTTEN) } ?: return false
        forgotten.forEach { it.deleteRecursively() }
        val left = instanceDirectory.listFiles { file -> file.name.startsWith(FORGOTTEN) } ?: return false
        return !accounts.exists() && left.isEmpty()
    }
}
