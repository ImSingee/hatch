package dev.hatch.app.core

import java.net.URLEncoder
import org.json.JSONArray
import org.json.JSONObject

/**
 * The host functions a Hatch native App may call, and the grant a shell
 * hands NSH for every App it runs.
 *
 * The list is the platform's `NATIVE_HOST_CALLS`
 * (`src/server/apps/native/nsh-config.ts`); a repository test keeps them
 * equal. The grant is exactly `{ "host": [...] }`: nothing else (no network,
 * clipboard, files or URLs). It must always be set: without a grant NSH lets
 * a package do whatever it declares.
 */
object HostCalls {
    val names: List<String> =
        listOf(
            "hatch.rpc",
            "hatch.data.query",
            "hatch.data.mutate",
            "hatch.data.events",
            "hatch.theme.get",
            "hatch.nav.setTitle",
            "hatch.nav.setRoute",
            "hatch.nav.open",
            "hatch.native.supports",
        )

    /** The capabilities document NSH reads (`setGrantedCapabilities`). */
    val grant: String = "{\"host\":[" + names.joinToString(",") { "\"$it\"" } + "]}"
}

/** Events a shell sends to a running App (`host.on` in the App). */
object HostEvents {
    const val THEME = "hatch.theme"
    const val NAV = "hatch.nav"
    const val VISIBILITY = "hatch.visibility"
    const val UPDATE = "hatch.update"
}

/**
 * What one running App may reach: its own id, its live deployment, the
 * unary methods its backend serves and whether it has Data Tables. Every
 * request the bridge makes is built from this scope alone, never from the
 * App's arguments, so an App reaches only `/api/app/<its id>/...`.
 */
data class AppScope
private constructor(
    val appId: String,
    val deploymentId: String,
    /** Unary methods by fully-qualified service name. */
    val rpcMethods: Map<String, Set<String>>,
    val hasData: Boolean,
) {
    fun withDeployment(deploymentId: String) = copy(deploymentId = deploymentId)

    companion object {
        /** Null for an id that is not a plain App id (it becomes a URL segment). */
        fun of(
            appId: String,
            deploymentId: String,
            rpcMethods: Map<String, Set<String>>,
            hasData: Boolean,
        ): AppScope? =
            if (isAppId(appId)) AppScope(appId, deploymentId, rpcMethods, hasData) else null

        fun isAppId(value: String): Boolean =
            value.isNotEmpty() &&
                value.length <= 191 &&
                value.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' || it == '-' || it == '_' }
    }
}

/** The shell side of the bridge: what the App's calls change outside it. */
interface BridgeShell {
    /** The NSH theme (JSON text) `hatch.theme.get` answers with; null keeps the App's own. */
    fun themeJson(): String?

    fun setTitle(title: String?)

    fun setRoute(route: String)

    /** Opens another App by slug; false when the shell cannot. */
    fun openApp(slug: String, route: String): Boolean

    /** The instance refused the credential (401). */
    fun unauthorized()

    /** The Data API says this deployment is no longer live (409). */
    fun deploymentStale()
}

/**
 * Answers an App's `hatch.*` host calls as the web player does: every
 * argument is checked, every request stays inside the App's scope, and
 * every answer is an envelope (`{ ok: true, ... }` or `{ ok: false, code,
 * message }`), never a rejection, which would lose its code. Calls block:
 * run them off the UI thread.
 */
class HostBridge(
    val origin: String,
    @Volatile var scope: AppScope,
    private val credential: () -> String?,
    private val transport: HttpTransport,
    private val shell: BridgeShell?,
    private val eventsWaitMillis: Long = EVENTS_WAIT_MILLIS,
) {
    companion object {
        const val MAX_TITLE_LENGTH = 256
        const val MAX_ROUTE_LENGTH = 4096
        /** How long one `hatch.data.events` call waits before answering "none". */
        const val EVENTS_WAIT_MILLIS = 25_000L

        private val SERVICE = Regex("^[A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)*$")
        private val METHOD = Regex("^[A-Za-z_]\\w*$")
        private val SLUG = Regex("^[a-z0-9][a-z0-9-]{0,63}$")

        fun refuse(code: String, message: String): Map<String, Any?> =
            mapOf("ok" to false, "code" to code, "message" to message)

        /** The Connect code for an HTTP status the instance answered with. */
        fun codeForStatus(status: Int): String =
            when (status) {
                400 -> "invalid_argument"
                401 -> "unauthenticated"
                403 -> "permission_denied"
                404 -> "not_found"
                409 -> "already_exists"
                429 -> "resource_exhausted"
                503 -> "unavailable"
                504 -> "deadline_exceeded"
                else -> if (status >= 500) "internal" else "unknown"
            }
    }

    /** Answers the host call `name` with `args` (NSH's decoded JSON: maps, lists, numbers, strings). */
    fun call(name: String, args: Any?): Map<String, Any?> {
        val input: Map<*, *> =
            when (args) {
                null, JSONObject.NULL -> emptyMap<String, Any?>()
                is Map<*, *> -> args
                else -> return refuse("invalid_argument", "$name takes an object.")
            }
        return when (name) {
            "hatch.rpc" -> rpc(input)
            "hatch.data.query" -> data("query", input)
            "hatch.data.mutate" -> data("mutate", input)
            "hatch.data.events" -> events(input)
            "hatch.theme.get" -> {
                val theme = shell?.themeJson()?.let { runCatching { Json.toJava(JSONObject(it)) }.getOrNull() }
                mapOf("ok" to true, "theme" to theme)
            }
            "hatch.nav.setTitle" -> {
                val title = input["title"]
                when {
                    title == null || title == JSONObject.NULL -> {
                        shell?.setTitle(null)
                        mapOf("ok" to true)
                    }
                    title is String && title.length <= MAX_TITLE_LENGTH -> {
                        shell?.setTitle(title.ifEmpty { null })
                        mapOf("ok" to true)
                    }
                    else ->
                        refuse(
                            "invalid_argument",
                            "hatch.nav.setTitle needs { title } (a string of at most $MAX_TITLE_LENGTH characters, or null).",
                        )
                }
            }
            "hatch.nav.setRoute" -> {
                val route = input["route"]
                if (route !is String || route.length > MAX_ROUTE_LENGTH || route.startsWith("#")) {
                    refuse("invalid_argument", "hatch.nav.setRoute needs { route }: a fragment without \"#\".")
                } else {
                    shell?.setRoute(route)
                    mapOf("ok" to true)
                }
            }
            "hatch.nav.open" -> {
                val slug = input["slug"]
                val route = input["route"] ?: ""
                if (slug !is String || !SLUG.matches(slug) || route !is String || route.length > MAX_ROUTE_LENGTH) {
                    refuse("invalid_argument", "hatch.nav.open needs { slug, route? }.")
                } else if (shell?.openApp(slug, route) == true) {
                    mapOf("ok" to true)
                } else {
                    refuse("unavailable", "No shell is showing this App.")
                }
            }
            "hatch.native.supports" -> mapOf("ok" to true, "capabilities" to emptyList<String>())
            else -> refuse("unimplemented", "$name is not a host function.")
        }
    }

    /** `/api/app/<scope's App id>/<rest>` on the instance. */
    internal fun appUrl(rest: String, query: String = ""): String =
        "$origin/api/app/${scope.appId}/$rest" + (if (query.isEmpty()) "" else "?$query")

    private fun authorized(headers: Map<String, String>): Map<String, String>? {
        val token = credential() ?: return null
        return headers + ("authorization" to "Bearer $token")
    }

    private fun perform(request: HttpRequest): Result<HttpResponse> =
        runCatching { transport.send(request) }.onSuccess { if (it.status == 401) shell?.unauthorized() }

    private fun rpc(input: Map<*, *>): Map<String, Any?> {
        val scope = this.scope
        if (scope.rpcMethods.isEmpty()) return refuse("unimplemented", "This App has no backend.")
        val service = input["service"]
        val method = input["method"]
        if (
            service !is String ||
                !SERVICE.matches(service) ||
                method !is String ||
                !METHOD.matches(method) ||
                !input.containsKey("message")
        ) {
            return refuse("invalid_argument", "hatch.rpc needs { service, method, message }.")
        }
        if (scope.rpcMethods[service]?.contains(method) != true) {
            return refuse("unimplemented", "$service/$method is not a unary method of this App.")
        }
        val headers =
            authorized(
                mapOf(
                    "content-type" to "application/json",
                    "connect-protocol-version" to "1",
                    "accept" to "application/json",
                )
            ) ?: return refuse("unauthenticated", "Sign in to this instance again.")
        val request =
            HttpRequest(
                "POST",
                appUrl("rpc/$service/$method"),
                headers,
                Json.stringify(input["message"]).toByteArray(),
            )
        val response = perform(request).getOrElse { return refuse("unavailable", it.toString()) }
        val text = String(response.body)
        val parsed: Any? = if (text.isEmpty()) emptyMap<String, Any?>() else runCatching { Json.parse(text) }.getOrNull()
        if (response.status !in 200..299) {
            val failure = parsed as? Map<*, *> ?: emptyMap<String, Any?>()
            return refuse(
                failure["code"] as? String ?: codeForStatus(response.status),
                failure["message"] as? String ?: "HTTP ${response.status}",
            )
        }
        parsed ?: return refuse("internal", "The backend answered with no JSON message.")
        return mapOf("ok" to true, "message" to parsed, "header" to response.headers)
    }

    private fun data(action: String, input: Map<*, *>): Map<String, Any?> {
        val scope = this.scope
        if (!scope.hasData) return refuse("unimplemented", "This App has no Data Tables.")
        val body = input["body"] as? Map<*, *> ?: return refuse("invalid_argument", "hatch.data.$action needs { body }.")
        val headers =
            authorized(mapOf("content-type" to "application/json", "x-hatch-data-deployment" to scope.deploymentId))
                ?: return refuse("unauthenticated", "Sign in to this instance again.")
        val request = HttpRequest("POST", appUrl("data/$action"), headers, Json.stringify(body).toByteArray())
        val response = perform(request).getOrElse { return refuse("unavailable", it.toString()) }
        val text = String(response.body)
        if (response.status !in 200..299) {
            if (response.status == 409) shell?.deploymentStale()
            return refuse(codeForStatus(response.status), text.ifEmpty { "HTTP ${response.status}" })
        }
        val result = runCatching { Json.parse(text) }.getOrElse { return refuse("internal", "The Data API answered with no JSON.") }
        return mapOf("ok" to true, "result" to result)
    }

    private fun events(input: Map<*, *>): Map<String, Any?> {
        val scope = this.scope
        if (!scope.hasData) return refuse("unimplemented", "This App has no Data Tables.")
        val table = input["table"]
        val since = input["since"]
        val sinceValue =
            when (since) {
                is Int -> since.toLong()
                is Long -> since
                is Double -> if (since % 1.0 == 0.0) since.toLong() else null
                else -> null
            }
        if (table !is String || table.isEmpty() || sinceValue == null || sinceValue < 0 || sinceValue > 9_007_199_254_740_991L) {
            return refuse("invalid_argument", "hatch.data.events needs { table, since }.")
        }
        val headers =
            authorized(mapOf("x-hatch-data-deployment" to scope.deploymentId, "accept" to "text/event-stream"))
                ?: return refuse("unauthenticated", "Sign in to this instance again.")
        val request =
            HttpRequest(
                "GET",
                appUrl("data/events", "since=$sinceValue&table=" + URLEncoder.encode(table, "UTF-8").replace("+", "%20")),
                headers,
                timeoutMillis = eventsWaitMillis + 5_000,
            )
        val found = mutableListOf<Map<String, Any?>>()
        // An SSE block's fields until its blank line: only the two this uses.
        var type: String? = null
        var id: String? = null
        val response =
            try {
                transport.lines(request, eventsWaitMillis) { line ->
                    when {
                        line.isEmpty() -> {
                            val event = type
                            val revision = id?.toLongOrNull()
                            type = null
                            id = null
                            if (event == null) return@lines true
                            found.add(mutableMapOf<String, Any?>("reset" to (event == "reset")).also {
                                if (revision != null && revision >= 0) it["revision"] = revision
                            })
                            false
                        }
                        line.startsWith("event:") -> {
                            if (type == null) type = line.substring(6).trim()
                            true
                        }
                        line.startsWith("id:") -> {
                            if (id == null) id = line.substring(3).trim()
                            true
                        }
                        else -> true
                    }
                }
            } catch (error: Exception) {
                return if (found.isEmpty()) refuse("unavailable", error.toString()) else mapOf("ok" to true, "events" to found.toList())
            }
        if (response.status !in 200..299) {
            if (response.status == 401) shell?.unauthorized()
            if (response.status == 409) shell?.deploymentStale()
            val text = String(response.body)
            return refuse(codeForStatus(response.status), text.ifEmpty { "HTTP ${response.status}" })
        }
        // At the deadline: what arrived (usually nothing).
        return mapOf("ok" to true, "events" to found.toList())
    }
}

/** JSON between org.json and the maps and lists NSH hands over. */
object Json {
    fun parse(text: String): Any? = toJava(org.json.JSONTokener(text).nextValue())

    fun toJava(value: Any?): Any? =
        when (value) {
            is JSONObject -> value.keys().asSequence().associateWith { toJava(value.get(it)) }
            is JSONArray -> (0 until value.length()).map { toJava(value.get(it)) }
            JSONObject.NULL -> null
            else -> value
        }

    fun stringify(value: Any?): String =
        when (value) {
            null -> "null"
            is Map<*, *>, is List<*> -> toJson(value).toString()
            is String -> JSONObject.quote(value)
            else -> JSONObject.wrap(value)?.toString() ?: "null"
        }

    /**
     * Maps and lists as org.json values, an explicit null kept as
     * `JSONObject.NULL`: `JSONObject.wrap` drops null entries on the JVM's
     * org.json but keeps them on Android's, and an App's `{ note: null }`
     * must reach its backend the same way everywhere.
     */
    private fun toJson(value: Any?): Any =
        when (value) {
            null -> JSONObject.NULL
            is Map<*, *> -> JSONObject().also { json -> for ((key, item) in value) json.put(key.toString(), toJson(item)) }
            is List<*> -> JSONArray().also { json -> for (item in value) json.put(toJson(item)) }
            else -> JSONObject.wrap(value) ?: JSONObject.NULL
        }
}
