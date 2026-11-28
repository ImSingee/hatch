package dev.hatch.app.core

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.json.JSONObject

class FakeTransport : HttpTransport {
    val requests = mutableListOf<HttpRequest>()
    var answer: (HttpRequest) -> HttpResponse = { HttpResponse(200, body = "{}".toByteArray()) }
    var lines = listOf<String>()

    override fun send(request: HttpRequest): HttpResponse {
        synchronized(requests) { requests.add(request) }
        return answer(request)
    }

    override fun lines(request: HttpRequest, deadlineMillis: Long, line: (String) -> Boolean): HttpResponse {
        synchronized(requests) { requests.add(request) }
        val response = answer(request)
        if (response.status !in 200..299) return response
        for (text in lines) if (!line(text)) break
        return HttpResponse(response.status)
    }
}

class RecordingShell : BridgeShell {
    val titles = mutableListOf<String?>()
    val routes = mutableListOf<String>()
    val opened = mutableListOf<String>()
    var unauthorizedCount = 0
    var staleCount = 0
    var theme: String? = null

    override fun themeJson() = theme

    override fun setTitle(title: String?) {
        titles.add(title)
    }

    override fun setRoute(route: String) {
        routes.add(route)
    }

    override fun openApp(slug: String, route: String): Boolean {
        opened.add(slug)
        return true
    }

    override fun unauthorized() {
        unauthorizedCount += 1
    }

    override fun deploymentStale() {
        staleCount += 1
    }
}

class HostBridgeTest {
    private val transport = FakeTransport()
    private val shell = RecordingShell()
    private val bridge =
        HostBridge(
            "https://hatch.example.test",
            AppScope.of("app1", "dep1", mapOf("app.v1.Counter" to setOf("Get", "Add")), true)!!,
            { "session-token" },
            transport,
            shell,
            eventsWaitMillis = 500,
        )

    private fun refused(answer: Map<String, Any?>, code: String) {
        assertEquals(false, answer["ok"], answer.toString())
        assertEquals(code, answer["code"], answer.toString())
    }

    private fun rpc(vararg pairs: Pair<String, Any?>) = bridge.call("hatch.rpc", mapOf(*pairs))

    @Test
    fun grantIsExactlyTheHostCalls() {
        val grant = JSONObject(HostCalls.grant)
        assertEquals(setOf("host"), grant.keySet())
        assertEquals(HostCalls.names, Json.toJava(grant.getJSONArray("host")))
    }

    @Test
    fun unknownHostNamesAreRefusedWithoutARequest() {
        for (name in listOf("evil.steal", "hatch.secret.read", "hatch.rpc.", "fetch", "")) {
            refused(bridge.call(name, emptyMap<String, Any?>()), "unimplemented")
        }
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun argumentsMustBeAnObject() {
        refused(bridge.call("hatch.rpc", listOf("a")), "invalid_argument")
        refused(bridge.call("hatch.nav.setRoute", "x"), "invalid_argument")
        refused(bridge.call("hatch.data.query", 3), "invalid_argument")
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun rpcStaysOnTheAppsOwnBackend() {
        transport.answer = { HttpResponse(200, body = """{"count":2}""".toByteArray()) }
        val answer = rpc("service" to "app.v1.Counter", "method" to "Add", "message" to mapOf("amount" to 1), "appId" to "other")
        assertEquals(true, answer["ok"])
        assertEquals(2, (answer["message"] as Map<*, *>)["count"])
        val request = transport.requests.single()
        assertEquals("https://hatch.example.test/api/app/app1/rpc/app.v1.Counter/Add", request.url)
        assertEquals("POST", request.method)
        assertEquals("Bearer session-token", request.headers["authorization"])
        assertEquals("1", request.headers["connect-protocol-version"])
        assertEquals("""{"amount":1}""", String(request.body!!))
    }

    @Test
    fun rpcRejectsNamesThatCouldLeaveTheApp() {
        val bad =
            listOf(
                mapOf("service" to "../../other/rpc/app.v1.Counter", "method" to "Add", "message" to emptyMap<String, Any>()),
                mapOf("service" to "app.v1.Counter", "method" to "Add/../../x", "message" to emptyMap<String, Any>()),
                mapOf("service" to "app.v1.Counter/", "method" to "Add", "message" to emptyMap<String, Any>()),
                mapOf("service" to "app.v1.Counter", "method" to "Add?x=1", "message" to emptyMap<String, Any>()),
                mapOf("service" to "app.v1.Counter", "method" to "Add"),
                mapOf("service" to 3, "method" to "Add", "message" to emptyMap<String, Any>()),
            )
        for (args in bad) refused(bridge.call("hatch.rpc", args), "invalid_argument")
        refused(rpc("service" to "app.v1.Counter", "method" to "Drop", "message" to emptyMap<String, Any>()), "unimplemented")
        refused(rpc("service" to "app.v1.Other", "method" to "Add", "message" to emptyMap<String, Any>()), "unimplemented")
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun rpcErrorsKeepTheConnectCode() {
        transport.answer = {
            HttpResponse(400, body = """{"code":"invalid_argument","message":"amount must be positive"}""".toByteArray())
        }
        val answer = rpc("service" to "app.v1.Counter", "method" to "Add", "message" to emptyMap<String, Any>())
        refused(answer, "invalid_argument")
        assertEquals("amount must be positive", answer["message"])
        transport.answer = { HttpResponse(401) }
        refused(rpc("service" to "app.v1.Counter", "method" to "Add", "message" to emptyMap<String, Any>()), "unauthenticated")
        assertEquals(1, shell.unauthorizedCount)
    }

    @Test
    fun dataCallsCarryTheLiveDeployment() {
        transport.answer = { HttpResponse(200, body = """{"items":[]}""".toByteArray()) }
        assertEquals(true, bridge.call("hatch.data.query", mapOf("body" to mapOf("table" to "counters")))["ok"])
        assertEquals("https://hatch.example.test/api/app/app1/data/query", transport.requests.last().url)
        assertEquals("dep1", transport.requests.last().headers["x-hatch-data-deployment"])
        bridge.scope = bridge.scope.withDeployment("dep2")
        bridge.call("hatch.data.mutate", mapOf("body" to mapOf("op" to "insert")))
        assertEquals("https://hatch.example.test/api/app/app1/data/mutate", transport.requests.last().url)
        assertEquals("dep2", transport.requests.last().headers["x-hatch-data-deployment"])
        refused(bridge.call("hatch.data.query", mapOf("body" to "x")), "invalid_argument")
    }

    @Test
    fun anExplicitNullReachesTheBackend() {
        bridge.call("hatch.data.mutate", mapOf("body" to mapOf("note" to null, "tags" to listOf(null, "a"))))
        val body = JSONObject(String(transport.requests.last().body!!))
        assertTrue(body.has("note") && body.isNull("note"), "the key stays, with null")
        assertTrue(body.getJSONArray("tags").isNull(0))
    }

    @Test
    fun staleDeploymentIsReported() {
        transport.answer = { HttpResponse(409, body = "inactive deployment".toByteArray()) }
        refused(bridge.call("hatch.data.query", mapOf("body" to emptyMap<String, Any>())), "already_exists")
        assertEquals(1, shell.staleCount)
        // An App that only watches for changes learns of it too.
        refused(bridge.call("hatch.data.events", mapOf("table" to "counters", "since" to 0)), "already_exists")
        assertEquals(2, shell.staleCount)
    }

    @Test
    fun eventsReadTheFirstChangeBlock() {
        transport.lines = listOf(": connected", "", "id: 7", "event: change", "data: {}", "", "id: 9", "event: change", "")
        val answer = bridge.call("hatch.data.events", mapOf("table" to "counters", "since" to 3))
        assertEquals(true, answer["ok"])
        val events = answer["events"] as List<*>
        assertEquals(listOf(mapOf("reset" to false, "revision" to 7L)), events)
        val request = transport.requests.last()
        assertEquals("GET", request.method)
        assertEquals("https://hatch.example.test/api/app/app1/data/events?since=3&table=counters", request.url)
        assertEquals("dep1", request.headers["x-hatch-data-deployment"])
    }

    @Test
    fun eventsArgumentsAreChecked() {
        for (args in
            listOf(
                mapOf("table" to "", "since" to 0),
                mapOf("table" to "t", "since" to -1),
                mapOf("table" to "t", "since" to 1.5),
                mapOf("table" to "t", "since" to "1"),
                mapOf("table" to "t"),
                mapOf("since" to 1),
            )) {
            refused(bridge.call("hatch.data.events", args), "invalid_argument")
        }
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun appsWithoutABackendOrDataAreRefused() {
        bridge.scope = AppScope.of("app1", "d", emptyMap(), false)!!
        refused(rpc("service" to "app.v1.Counter", "method" to "Add", "message" to emptyMap<String, Any>()), "unimplemented")
        refused(bridge.call("hatch.data.query", mapOf("body" to emptyMap<String, Any>())), "unimplemented")
        refused(bridge.call("hatch.data.events", mapOf("table" to "t", "since" to 0)), "unimplemented")
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun navigationArgumentsAreChecked() {
        assertEquals(true, bridge.call("hatch.nav.setTitle", mapOf("title" to "Orders"))["ok"])
        assertEquals(true, bridge.call("hatch.nav.setTitle", mapOf("title" to null))["ok"])
        refused(bridge.call("hatch.nav.setTitle", mapOf("title" to "x".repeat(257))), "invalid_argument")
        refused(bridge.call("hatch.nav.setTitle", mapOf("title" to 3)), "invalid_argument")
        assertEquals(listOf("Orders", null), shell.titles)

        assertEquals(true, bridge.call("hatch.nav.setRoute", mapOf("route" to "orders/7"))["ok"])
        refused(bridge.call("hatch.nav.setRoute", mapOf("route" to "#orders")), "invalid_argument")
        refused(bridge.call("hatch.nav.setRoute", mapOf("route" to "x".repeat(4097))), "invalid_argument")
        assertEquals(listOf("orders/7"), shell.routes)

        assertEquals(true, bridge.call("hatch.nav.open", mapOf("slug" to "notes", "route" to "a"))["ok"])
        for (slug in listOf<Any>("Notes", "-x", "../x", "a/b", "a".repeat(65), 3)) {
            refused(bridge.call("hatch.nav.open", mapOf("slug" to slug)), "invalid_argument")
        }
        assertEquals(listOf("notes"), shell.opened)
    }

    @Test
    fun themeAndSupports() {
        assertNull(bridge.call("hatch.theme.get", null)["theme"])
        shell.theme = """{"cssVars":{"light":{"primary":"#123456"}}}"""
        assertNotNull((bridge.call("hatch.theme.get", emptyMap<String, Any>())["theme"] as Map<*, *>)["cssVars"])
        assertEquals(emptyList<String>(), bridge.call("hatch.native.supports", emptyMap<String, Any>())["capabilities"])
    }

    @Test
    fun scopeRefusesIdsThatAreNotSegments() {
        for (id in listOf("", "a/b", "..", "a?b", "a#b", "a b", "a".repeat(192))) {
            assertNull(AppScope.of(id, "d", emptyMap(), false), id)
        }
        assertNotNull(AppScope.of("01m8ffbv5zpxnpavahvq9aq51x", "d", emptyMap(), true))
    }

    @Test
    fun noCredentialMeansNoRequest() {
        val anonymous = HostBridge("https://hatch.example.test", bridge.scope, { null }, transport, shell)
        refused(
            anonymous.call("hatch.rpc", mapOf("service" to "app.v1.Counter", "method" to "Add", "message" to emptyMap<String, Any>())),
            "unauthenticated",
        )
        assertTrue(transport.requests.isEmpty())
    }
}

class SumHasher : PackageHasher {
    private var sum = 0L

    override fun update(data: ByteArray) {
        for (byte in data) sum = (sum * 31 + (byte.toInt() and 0xff)) and 0xffffffffL
    }

    override fun hexDigest(): String = sum.toString(16)
}

class PlatformClientTest {
    private fun frame(value: Map<String, Any?>, end: Boolean = false): ByteArray {
        val out = PlatformClient.envelope(Json.stringify(value).toByteArray())
        if (end) out[0] = 2
        return out
    }

    private fun stream(bytes: ByteArray, size: Int? = null, sha: String? = null): ByteArray {
        val hasher = SumHasher().also { it.update(bytes) }
        val half = bytes.size / 2
        val encoder = java.util.Base64.getEncoder()
        return frame(
            mapOf(
                "package" to
                    mapOf(
                        "appId" to "app1",
                        "deploymentId" to "dep1",
                        "version" to 2,
                        "build" to 7,
                        "nshAppId" to "dev.hatch.app.app1",
                        "sha256" to (sha ?: hasher.hexDigest()),
                        "size" to (size ?: bytes.size),
                        "keyId" to "k1",
                    )
            )
        ) +
            frame(mapOf("chunk" to encoder.encodeToString(bytes.copyOfRange(0, half)))) +
            frame(mapOf("chunk" to encoder.encodeToString(bytes.copyOfRange(half, bytes.size)))) +
            frame(emptyMap(), end = true)
    }

    @Test
    fun readsAVerifiedPackage() {
        val bytes = ByteArray(1000) { (it % 251).toByte() }
        val (info, data) = PlatformClient.readPackage(stream(bytes), SumHasher())
        assertEquals(7, info.build)
        assertEquals("dep1", info.deploymentId)
        assertTrue(bytes.contentEquals(data))
    }

    @Test
    fun refusesAPackageThatDoesNotMatch() {
        val bytes = byteArrayOf(1, 2, 3, 4)
        assertFailsWith<PlatformException> { PlatformClient.readPackage(stream(bytes, size = 5), SumHasher()) }
        assertFailsWith<PlatformException> { PlatformClient.readPackage(stream(bytes, sha = "0"), SumHasher()) }
        val whole = stream(bytes)
        assertFailsWith<PlatformException> { PlatformClient.readPackage(whole.copyOf(whole.size - 3), SumHasher()) }
        val end = PlatformClient.envelope("{}".toByteArray()).size
        assertFailsWith<PlatformException> { PlatformClient.readPackage(whole.copyOf(whole.size - end), SumHasher()) }
    }

    @Test
    fun anErrorInTheEndFrameCarriesItsCodes() {
        val body =
            frame(
                mapOf(
                    "error" to
                        mapOf(
                            "code" to "failed_precondition",
                            "message" to "This App has a web frontend.",
                            "details" to listOf(mapOf("debug" to mapOf("code" to "APP_NOT_NATIVE"))),
                        )
                ),
                end = true,
            )
        val error = assertFailsWith<PlatformException> { PlatformClient.readPackage(body, SumHasher()) }
        assertEquals("failed_precondition", error.code)
        assertEquals("APP_NOT_NATIVE", error.publicCode)
    }

    @Test
    fun describesAnAppFromItsView() {
        val transport = FakeTransport()
        transport.answer = {
            HttpResponse(
                200,
                body =
                    """{"resource":{"view":{"id":"app1","slug":"notes","name":"Notes","currentDeploymentId":"dep9",
                    "capabilities":["frontend","backend","dataTable"],"frontend":{"runtime":"native","packageBuild":4},
                    "manifest":{"api":{"services":[{"name":"app.v1.Notes","methods":[
                    {"name":"List","clientStreaming":false,"serverStreaming":false},
                    {"name":"Watch","clientStreaming":false,"serverStreaming":true}]}]}}}}}"""
                        .toByteArray(),
            )
        }
        val app = PlatformClient("https://hatch.example.test", { "t" }, transport).describeApp("notes")
        assertEquals("native", app.runtime)
        assertEquals(4, app.packageBuild)
        assertEquals("dep9", app.deploymentId)
        assertEquals(mapOf("app.v1.Notes" to setOf("List")), app.rpcMethods)
        assertTrue(app.hasData)
        assertEquals("https://hatch.example.test/api/rpc/hatch.platform.v1.AppService/GetApp", transport.requests.single().url)
        assertEquals("Bearer t", transport.requests.single().headers["authorization"])
    }
}

class RunLedgerTest {
    private val start = 1_000_000_000L

    @Test
    fun theLeastRecentlyShownAppStopsAtTheLimit() {
        val ledger = RunLedger(3)
        for ((index, app) in listOf("a", "b", "c").withIndex()) {
            ledger.setVisible(setOf(app), start + index)
            ledger.start(app, "r-$app", start + index)
        }
        ledger.setVisible(setOf("c"), start + 3)
        ledger.setRoute("a-later", "a")
        assertEquals(listOf("a"), ledger.start("d", "", start + 4))
        assertEquals(listOf("b", "c", "d"), ledger.running)
        assertEquals("a-later", ledger.route("a"))
        assertEquals(emptyList(), ledger.start("c", "x", start + 5))
    }

    @Test
    fun anAppOnScreenIsNeverTheOneStopped() {
        val ledger = RunLedger(2)
        ledger.setVisible(setOf("a"), start)
        ledger.start("a", "", start)
        ledger.start("b", "", start + 1)
        ledger.setVisible(setOf("a"), start + 2)
        assertEquals(listOf("b"), ledger.start("c", "", start + 3))
    }

    @Test
    fun hiddenAppsStopAfterTheBackgroundTime() {
        val ledger = RunLedger(3, backgroundMinutes = 5)
        ledger.setVisible(setOf("a"), start)
        ledger.start("a", "orders/7", start)
        ledger.start("b", "", start)
        ledger.setVisible(setOf("b"), start + 60_000)
        assertEquals(emptyList<String>() to start + 360_000, ledger.stopWaiting(start + 299_000))
        assertEquals(listOf("a") to null, ledger.stopWaiting(start + 360_000))
        assertEquals("orders/7", ledger.route("a"))
        // The whole app in the background: every App starts waiting.
        ledger.setVisible(emptySet(), start + 400_000)
        assertEquals(emptyList(), ledger.stopWaiting(start + 699_000).first)
        assertEquals(listOf("b"), ledger.stopWaiting(start + 700_000).first)
    }

    @Test
    fun showingAnAppAgainResetsItsWait() {
        val ledger = RunLedger(3, backgroundMinutes = 1)
        ledger.start("a", "", start)
        ledger.setVisible(emptySet(), start)
        ledger.setVisible(setOf("a"), start + 50_000)
        ledger.setVisible(emptySet(), start + 55_000)
        assertEquals(emptyList(), ledger.stopWaiting(start + 100_000).first)
        assertEquals(listOf("a"), ledger.stopWaiting(start + 115_000).first)
    }

    @Test
    fun theSetupIsTheFixedGrantAndHeap() {
        val setup = EngineSetup.of("android", "", 3, "app1", java.io.File("/data/i"), java.io.File("/cache/i"))
        assertEquals(HostCalls.grant, setup.grant)
        assertEquals(96, setup.heapMegabytes)
        assertEquals(mapOf<String, Any>("platform" to "android", "route" to "", "packageBuild" to 3), setup.params)
        assertEquals("/data/i/storage/app1", setup.storageDirectory.path)
    }
}

class TrustRefreshTest {
    /**
     * Takes only a newer, validly signed list, as NSH does: in memory first,
     * then saved to `state` (unless `failSave`).
     */
    class FakeStore(var sequence: Int = 0, private val state: File? = null, var failSave: Boolean = false) :
        TrustStore {
        val roots = mutableListOf<String>()
        var closed = false

        override fun addRoot(publicKey: String) = roots.add(publicKey)

        override fun updateRevocations(json: String): Boolean {
            val (signed, number) = json.split(":")
            if (signed != "signed" || number.toInt() <= sequence) return false
            sequence = number.toInt()
            if (state == null) return true
            if (failSave) return false
            state.writeText(Json.stringify(mapOf("revocations" to json)))
            return true
        }

        override fun close() {
            closed = true
        }

        companion object {
            /** A store opened from what `state` holds. */
            fun opened(state: File): FakeStore {
                val saved = runCatching { (Json.parse(state.readText()) as Map<*, *>)["revocations"] as String }
                return FakeStore(saved.map { it.split(":")[1].toInt() }.getOrDefault(0), state)
            }
        }
    }

    private fun material(sequence: Int, list: String? = "signed:$sequence") =
        RuntimeTrust(initialized = true, roots = listOf("root"), revocations = list, revocationSequence = sequence)

    private class Dir {
        val dir = kotlin.io.path.createTempDirectory().toFile()
        val marker = File(dir, "sequence")
        val state = File(dir, "nsh-trust.json")

        fun refresh() = TrustRefresh(marker, state)
    }

    @Test
    fun aListTheStoreAlreadySavedIsNotAFailure() {
        val d = Dir()
        val store = FakeStore(state = d.state)
        d.refresh().refresh(store, material(8), { FakeStore.opened(d.state) }) { FakeStore() }
        // The store saved list 8 but the marker still says 7 (its write was lost).
        d.marker.writeText("7")
        d.refresh().refresh(store, material(8), { error("not needed") }) { error("not needed") }
        assertEquals("8", d.marker.readText())
        // Newer lists still apply.
        d.refresh().refresh(store, material(9), { FakeStore.opened(d.state) }) { FakeStore() }
        assertEquals(9, store.sequence)
    }

    @Test
    fun aListTakenButNotSavedIsSavedBeforeTheMarkerMoves() {
        val d = Dir()
        val store = FakeStore(state = d.state, failSave = true)
        // NSH kept list 8 in memory but could not save it: nothing is recorded.
        assertFailsWith<IllegalStateException> {
            d.refresh().refresh(store, material(8), { FakeStore.opened(d.state).also { it.failSave = true } }) {
                FakeStore()
            }
        }
        assertEquals(false, d.marker.exists())
        // The next open saves it through a store opened from disk, then records it.
        val reopened = mutableListOf<FakeStore>()
        d.refresh().refresh(store, material(8), { FakeStore.opened(d.state).also { reopened += it } }) { FakeStore() }
        assertEquals("8", d.marker.readText())
        assertEquals(8, FakeStore.opened(d.state).sequence)
        assertEquals(true, reopened.single().closed)
    }

    @Test
    fun anInvalidNewerListStopsEverything() {
        val d = Dir()
        d.marker.writeText("7")
        assertFailsWith<IllegalStateException> {
            d.refresh().refresh(FakeStore(sequence = 7), material(8, "forged:8"), { FakeStore(7) }) { FakeStore() }
        }
        assertEquals("7", d.marker.readText())
    }

    @Test
    fun rootsAreAddedOncePerStore() {
        val refresh = Dir().refresh()
        val store = FakeStore()
        refresh.refresh(store, material(1), { FakeStore() }) { FakeStore() }
        refresh.refresh(store, material(1), { FakeStore() }) { FakeStore() }
        assertEquals(listOf("root"), store.roots)
    }
}
