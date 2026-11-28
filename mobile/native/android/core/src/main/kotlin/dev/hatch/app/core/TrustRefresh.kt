package dev.hatch.app.core

import java.io.File

/** What the runtime needs of NSH's trust store (`NshTrust`). */
interface TrustStore {
    /** Trusts a root key; a store that already trusts it answers true too. */
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
 *   store took the list but did not save it: the store is opened again from
 *   what is saved (`reopen`, which replaces it) and takes the list, saving
 *   it, or the open fails and the next one tries again.
 *
 * Every store gets the roots: NSH opens a store trusting none.
 */
class TrustRefresh(private val marker: File, private val state: File) {
    fun refresh(
        store: TrustStore,
        material: RuntimeTrust,
        reopen: () -> TrustStore,
        fresh: () -> TrustStore,
    ) {
        if (!material.initialized) {
            throw PlatformException("failed_precondition", message = "This instance has no native App keys yet.")
        }
        trustRoots(store, material.roots)
        val list = material.revocations ?: return
        val applied = runCatching { marker.readText().trim().toInt() }.getOrDefault(0)
        if (material.revocationSequence <= applied) return
        if (!store.updateRevocations(list) && !saves(list)) {
            val probe = fresh()
            try {
                trustRoots(probe, material.roots)
                check(probe.updateRevocations(list)) { "The instance's revocation list is not valid." }
            } finally {
                probe.close()
            }
            val reopened = reopen()
            trustRoots(reopened, material.roots)
            check(reopened.updateRevocations(list)) { "Could not save the instance's revocation list." }
        }
        marker.parentFile?.mkdirs()
        val partial = File(marker.parentFile, "${marker.name}.partial")
        partial.writeText(material.revocationSequence.toString())
        check(partial.renameTo(marker)) { "Could not record the revocation list." }
    }

    private fun trustRoots(store: TrustStore, roots: List<String>) {
        for (root in roots) check(store.addRoot(root)) { "The instance's root key is not valid." }
    }

    /** Whether the saved state holds `list` itself. */
    private fun saves(list: String): Boolean {
        val saved = runCatching { (Json.parse(state.readText()) as? Map<*, *>)?.get("revocations") }.getOrNull()
        // Lists are JSON objects; anything else is compared as it is written.
        val wanted = runCatching { Json.parse(list) }.getOrNull()?.takeIf { it is Map<*, *> } ?: list
        return saved != null && saved == wanted
    }
}

/**
 * The one trust store of an instance's trust directory, shared by every
 * session for that instance. NSH saves a store's whole state at once, so a
 * second store on the same directory could write back what it read before
 * the first saved (a revocation list, an accepted build). One store, and one
 * caller at a time: refreshing it, replacing it, and whatever `use` runs with
 * it (opening and accepting a package) never overlap, and a session that
 * ended (`active` false) neither refreshes nor uses it.
 */
class TrustDirectory<S : TrustStore>(
    private val refresh: TrustRefresh,
    private val open: () -> S,
    private val fresh: () -> TrustStore,
) {
    private var store: S? = null

    @Synchronized
    fun <T> use(material: RuntimeTrust, active: () -> Boolean, block: (S) -> T): T {
        if (!active()) throw PlatformException("unauthenticated", message = "Sign in to this instance again.")
        refresh.refresh(
            store ?: open().also { store = it },
            material,
            reopen = {
                store?.close()
                open().also { store = it }
            },
            fresh,
        )
        val current = store!!
        if (!active()) throw PlatformException("unauthenticated", message = "Sign in to this instance again.")
        return block(current)
    }
}
