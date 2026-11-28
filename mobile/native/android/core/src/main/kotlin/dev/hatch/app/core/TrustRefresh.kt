package dev.hatch.app.core

import java.io.File

/** What the runtime needs of NSH's trust store (`NshTrust`). */
interface TrustStore {
    fun addRoot(publicKey: String): Boolean

    /** Applies a signed revocation list; false when the store refuses it. */
    fun updateRevocations(json: String): Boolean

    fun close() {}
}

/**
 * Brings a trust store up to the instance's material before a package is
 * opened: its roots, and its revocation list whenever the instance has a
 * newer one than the store was given (`marker` keeps that sequence).
 *
 * NSH takes only a newer list, and it takes a list in memory before saving
 * it to `state` (its `nsh-trust.json`). So when the store refuses a list the
 * marker calls newer, the marker moves only once that list is saved:
 * - `state` already holds this list: the marker's own write was lost.
 * - Otherwise a store with nothing applied (`fresh`) checks the list. If it
 *   refuses, the list is not valid and nothing opens. If it takes it, the
 *   store took the list but did not save it: a store opened again from what
 *   is saved (`reopen`) takes it and saves it, or the open fails and the next
 *   one tries again.
 */
class TrustRefresh(private val marker: File, private val state: File) {
    private val roots = mutableSetOf<String>()

    @Synchronized
    fun refresh(
        store: TrustStore,
        material: RuntimeTrust,
        reopen: () -> TrustStore,
        fresh: () -> TrustStore,
    ) {
        if (!material.initialized) {
            throw PlatformException("failed_precondition", message = "This instance has no native App keys yet.")
        }
        for (root in material.roots) {
            if (root in roots) continue
            check(store.addRoot(root)) { "The instance's root key is not valid." }
            roots.add(root)
        }
        val list = material.revocations ?: return
        val applied = runCatching { marker.readText().trim().toInt() }.getOrDefault(0)
        if (material.revocationSequence <= applied) return
        if (!store.updateRevocations(list) && !saves(list)) {
            check(applies(fresh(), list)) { "The instance's revocation list is not valid." }
            check(applies(reopen(), list)) { "Could not save the instance's revocation list." }
        }
        marker.parentFile?.mkdirs()
        val partial = File(marker.parentFile, "${marker.name}.partial")
        partial.writeText(material.revocationSequence.toString())
        check(partial.renameTo(marker)) { "Could not record the revocation list." }
    }

    private fun applies(store: TrustStore, list: String): Boolean =
        try {
            for (root in roots) store.addRoot(root)
            store.updateRevocations(list)
        } finally {
            store.close()
        }

    /** Whether the saved state holds `list` itself. */
    private fun saves(list: String): Boolean {
        val saved = runCatching { (Json.parse(state.readText()) as? Map<*, *>)?.get("revocations") }.getOrNull()
        // Lists are JSON objects; anything else is compared as it is written.
        val wanted = runCatching { Json.parse(list) }.getOrNull()?.takeIf { it is Map<*, *> } ?: list
        return saved != null && saved == wanted
    }
}
