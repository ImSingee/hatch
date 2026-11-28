package dev.hatch.app.runtime

import android.app.Activity
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.longbridge.nsh.NshView
import dev.hatch.app.core.EngineSetup
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/** An activity for the engine tests: NSH views live in one. */
class EngineTestActivity : Activity()

/**
 * The grant on a real engine. The fixture (`mobile/native/fixtures/grant-probe`,
 * built into the test assets by `mobile/native/scripts/test-android.sh`)
 * declares every capability and reports what it reached.
 */
@RunWith(AndroidJUnit4::class)
class GrantTest {
    private fun probe(configure: (NshView, Activity) -> Unit): Map<String, String> {
        val reported = CountDownLatch(1)
        var results = mutableMapOf<String, String>()
        var reached = false
        var failure: String? = null
        var engine: NshView? = null
        ActivityScenario.launch(EngineTestActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val view = NshView(activity)
                engine = view
                activity.setContentView(FrameLayout(activity).apply { addView(view) })
                configure(view, activity)
                view.setErrorListener { failure = it }
                view.handle("probe.reach") { _, reply ->
                    reached = true
                    reply.resolve(mapOf("ok" to true))
                }
                view.handle("hatch.nav.setTitle") { data, reply ->
                    val title = (data as? Map<*, *>)?.get("title") as? String ?: "{}"
                    val json = JSONObject(title)
                    results = json.keys().asSequence().associateWith { json.getString(it) }.toMutableMap()
                    reply.resolve(mapOf("ok" to true))
                    reported.countDown()
                }
                assertTrue(view.loadAssetBundle("grant-probe"), "run mobile/native/scripts/test-android.sh, which builds the fixture")
            }
            try {
                assertTrue(reported.await(30, TimeUnit.SECONDS), "the probe reports")
            } finally {
                scenario.onActivity { engine?.destroy() }
            }
        }
        assertNull(failure)
        results["reached"] = if (reached) "yes" else "no"
        return results
    }

    @Test
    fun everyEngineGetsOnlyTheHostCalls() {
        val results = probe { view, activity ->
            view.apply(
                EngineSetup.of("android", "", 1, "grant-probe", File(activity.filesDir, "grant-test"), activity.cacheDir)
            )
        }
        assertEquals("ERR_ACCESS_DENIED", results["fetch"])
        assertEquals("ERR_ACCESS_DENIED", results["clipboard"])
        assertEquals("ERR_ACCESS_DENIED", results["openUrl"])
        assertEquals("ERR_ACCESS_DENIED", results["host"])
        assertEquals("no", results["reached"])
    }

    /** Why the grant must always be set: without one NSH lets a package do whatever it declares. */
    @Test
    fun withoutAGrantThePackageGetsWhatItDeclares() {
        val results = probe { view, _ -> view.setGrantedCapabilities(null) }
        assertEquals("OK", results["clipboard"])
        assertEquals("OK", results["host"])
        assertEquals("yes", results["reached"])
    }
}
