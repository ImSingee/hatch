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
 * NSH takes only a newer list and checks its signature first. So when the
 * store refuses a list the marker calls newer (the marker was not written
 * after the store took it), a store with nothing applied (`fresh`) settles
 * it: if that one takes the list, it is valid and the store already has it
 * or a newer one; if not, the list is not valid and nothing opens.
 */
class TrustRefresh(private val marker: File) {
    private val roots = mutableSetOf<String>()

    @Synchronized
    fun refresh(store: TrustStore, material: RuntimeTrust, fresh: () -> TrustStore) {
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
        if (!store.updateRevocations(list)) {
            val probe = fresh()
            try {
                for (root in roots) probe.addRoot(root)
                check(probe.updateRevocations(list)) { "The instance's revocation list is not valid." }
            } finally {
                probe.close()
            }
        }
        marker.parentFile?.mkdirs()
        val partial = File(marker.parentFile, "${marker.name}.partial")
        partial.writeText(material.revocationSequence.toString())
        check(partial.renameTo(marker)) { "Could not record the revocation list." }
    }
}
