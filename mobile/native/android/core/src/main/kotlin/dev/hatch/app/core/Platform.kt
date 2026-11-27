package dev.hatch.app.core

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/** One HTTP request the runtime makes to the Hatch instance. */
data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: ByteArray? = null,
    val timeoutMillis: Long = 30_000,
)

class HttpResponse(val status: Int, val headers: Map<String, String> = emptyMap(), val body: ByteArray = ByteArray(0))

/** How the runtime reaches the instance; tests use a fake. Calls block. */
interface HttpTransport {
    fun send(request: HttpRequest): HttpResponse

    /**
     * Sends `request` and hands each line of the body to `line` until it
     * returns false or the body ends. A status other than 2xx returns the
     * body whole instead.
     */
    fun lines(request: HttpRequest, line: (String) -> Boolean): HttpResponse
}

/** The instance over HttpURLConnection: no cookies, no cache, no redirects. */
class UrlConnectionTransport : HttpTransport {
    private fun open(request: HttpRequest): HttpURLConnection {
        val connection = URL(request.url).openConnection() as HttpURLConnection
        connection.requestMethod = request.method
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.connectTimeout = request.timeoutMillis.toInt()
        connection.readTimeout = request.timeoutMillis.toInt()
        for ((name, value) in request.headers) connection.setRequestProperty(name, value)
        request.body?.let { body ->
            connection.doOutput = true
            connection.outputStream.use { it.write(body) }
        }
        return connection
    }

    private fun headers(connection: HttpURLConnection): Map<String, String> =
        connection.headerFields.entries
            .filter { it.key != null && it.value.isNotEmpty() }
            .associate { it.key.lowercase() to it.value.joinToString(", ") }

    override fun send(request: HttpRequest): HttpResponse {
        val connection = open(request)
        try {
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { input -> ByteArrayOutputStream().also { input.copyTo(it) }.toByteArray() }
            return HttpResponse(status, headers(connection), body ?: ByteArray(0))
        } finally {
            connection.disconnect()
        }
    }

    override fun lines(request: HttpRequest, line: (String) -> Boolean): HttpResponse {
        val connection = open(request)
        try {
            val status = connection.responseCode
            if (status !in 200..299) {
                val body = connection.errorStream?.use { it.readBytes() } ?: ByteArray(0)
                return HttpResponse(status, headers(connection), body)
            }
            connection.inputStream.bufferedReader().use { reader ->
                while (true) {
                    val text = reader.readLine() ?: break
                    if (!line(text)) break
                }
            }
            return HttpResponse(status, headers(connection))
        } finally {
            connection.disconnect()
        }
    }
}

/** A failed platform request: a Connect code and the platform's own (`APP_NOT_NATIVE`). */
class PlatformException(val code: String, val publicCode: String? = null, message: String) : Exception(message)

/** The live deployment of an App, as `GetApp` describes it. */
data class AppDescription(
    val appId: String,
    val slug: String,
    val name: String,
    /** `native` or `web`; null without a live frontend. */
    val runtime: String?,
    val packageBuild: Int?,
    val deploymentId: String?,
    val rpcMethods: Map<String, Set<String>>,
    val hasData: Boolean,
)

/** `AppPackage`, the first message of `GetAppPackage`. */
data class AppPackageInfo(
    val appId: String,
    val deploymentId: String,
    val version: Int,
    val build: Int,
    val nshAppId: String,
    val sha256: String,
    val size: Int,
    val keyId: String,
)

data class RuntimeTrust(val initialized: Boolean, val roots: List<String>, val revocations: String?)

/** Incremental SHA-256 (MessageDigest at runtime). */
interface PackageHasher {
    fun update(data: ByteArray)

    fun hexDigest(): String
}

/** The platform's public Connect API (`/api/rpc`) with the session's bearer. Calls block. */
class PlatformClient(
    val origin: String,
    private val credential: () -> String?,
    private val transport: HttpTransport,
) {
    class Frame(val flags: Int, val payload: ByteArray) {
        val isEnd: Boolean
            get() = flags and 0x02 != 0
    }

    companion object {
        fun error(body: Map<*, *>?, status: Int): PlatformException {
            val error = body?.get("error") as? Map<*, *> ?: body ?: emptyMap<String, Any?>()
            val publicCode =
                (error["details"] as? List<*>)
                    ?.firstNotNullOfOrNull { ((it as? Map<*, *>)?.get("debug") as? Map<*, *>)?.get("code") as? String }
            return PlatformException(
                error["code"] as? String ?: HostBridge.codeForStatus(status),
                publicCode,
                error["message"] as? String ?: "HTTP $status",
            )
        }

        /** Splits a Connect streaming body into its enveloped messages. */
        fun frames(body: ByteArray): List<Frame> {
            val out = mutableListOf<Frame>()
            var index = 0
            while (index < body.size) {
                if (index + 5 > body.size) {
                    throw PlatformException("internal", message = "The package stream ended inside a frame.")
                }
                val length =
                    (body[index + 1].toInt() and 0xff shl 24) or
                        (body[index + 2].toInt() and 0xff shl 16) or
                        (body[index + 3].toInt() and 0xff shl 8) or
                        (body[index + 4].toInt() and 0xff)
                val start = index + 5
                if (length < 0 || start + length > body.size) {
                    throw PlatformException("internal", message = "The package stream ended inside a frame.")
                }
                out.add(Frame(body[index].toInt() and 0xff, body.copyOfRange(start, start + length)))
                index = start + length
            }
            return out
        }

        fun envelope(payload: ByteArray): ByteArray {
            val out = ByteArray(5 + payload.size)
            out[1] = (payload.size ushr 24).toByte()
            out[2] = (payload.size ushr 16).toByte()
            out[3] = (payload.size ushr 8).toByte()
            out[4] = payload.size.toByte()
            payload.copyInto(out, 5)
            return out
        }

        private fun int(value: Any?): Int? = (value as? Number)?.toInt()

        fun packageInfo(map: Map<*, *>): AppPackageInfo? {
            return AppPackageInfo(
                appId = map["appId"] as? String ?: return null,
                deploymentId = map["deploymentId"] as? String ?: return null,
                version = int(map["version"]) ?: 0,
                build = int(map["build"]) ?: return null,
                nshAppId = map["nshAppId"] as? String ?: return null,
                sha256 = (map["sha256"] as? String ?: return null).lowercase(),
                size = int(map["size"]) ?: return null,
                keyId = map["keyId"] as? String ?: "",
            )
        }

        /** Reads a whole `GetAppPackage` stream, checked against its size and SHA-256. */
        fun readPackage(body: ByteArray, hasher: PackageHasher): Pair<AppPackageInfo, ByteArray> {
            var info: AppPackageInfo? = null
            val bytes = ByteArrayOutputStream()
            var ended = false
            for (frame in frames(body)) {
                val message = runCatching { Json.parse(String(frame.payload)) as? Map<*, *> }.getOrNull()
                if (frame.isEnd) {
                    message?.get("error")?.let { throw error(mapOf("error" to it), 200) }
                    ended = true
                    break
                }
                val description = message?.get("package") as? Map<*, *>
                val chunk = message?.get("chunk") as? String
                when {
                    description != null -> {
                        if (info != null) throw PlatformException("internal", message = "The package stream described it twice.")
                        info = packageInfo(description)
                            ?: throw PlatformException("internal", message = "The package stream described it wrongly.")
                    }
                    chunk != null -> {
                        if (info == null) throw PlatformException("internal", message = "The package stream sent bytes first.")
                        val data = Base64.getDecoder().decode(chunk)
                        hasher.update(data)
                        bytes.write(data)
                    }
                    else -> throw PlatformException("internal", message = "The package stream sent an unknown message.")
                }
            }
            val described = info
            if (!ended || described == null) throw PlatformException("internal", message = "The package stream ended early.")
            if (bytes.size() != described.size || hasher.hexDigest() != described.sha256) {
                throw PlatformException("data_loss", message = "The package does not match its size and SHA-256.")
            }
            return described to bytes.toByteArray()
        }
    }

    private fun url(service: String, method: String) = "$origin/api/rpc/$service/$method"

    private fun headers(contentType: String): Map<String, String> {
        val token = credential() ?: throw PlatformException("unauthenticated", message = "Sign in to this instance again.")
        return mapOf(
            "content-type" to contentType,
            "connect-protocol-version" to "1",
            "authorization" to "Bearer $token",
        )
    }

    /** A unary call; throws [PlatformException]. */
    fun unary(service: String, method: String, body: Map<String, Any?> = emptyMap()): Map<*, *> {
        val response =
            transport.send(
                HttpRequest("POST", url(service, method), headers("application/json"), Json.stringify(body).toByteArray())
            )
        val parsed = runCatching { Json.parse(String(response.body)) as? Map<*, *> }.getOrNull()
        if (response.status !in 200..299 || parsed == null) throw error(parsed, response.status)
        return parsed
    }

    fun describeApp(id: String): AppDescription {
        val view =
            ((unary("hatch.platform.v1.AppService", "GetApp", mapOf("id" to id))["resource"] as? Map<*, *>)?.get("view")
                as? Map<*, *>) ?: throw PlatformException("internal", message = "The instance described the App wrongly.")
        val frontend = view["frontend"] as? Map<*, *>
        val manifest = view["manifest"] as? Map<*, *>
        val methods = mutableMapOf<String, Set<String>>()
        for (service in (manifest?.get("api") as? Map<*, *>)?.get("services") as? List<*> ?: emptyList<Any?>()) {
            val entry = service as? Map<*, *> ?: continue
            val name = entry["name"] as? String ?: continue
            methods[name] =
                (entry["methods"] as? List<*> ?: emptyList<Any?>())
                    .mapNotNull { it as? Map<*, *> }
                    .filter { it["clientStreaming"] != true && it["serverStreaming"] != true }
                    .mapNotNull { it["name"] as? String }
                    .toSet()
        }
        return AppDescription(
            appId = view["id"] as? String ?: throw PlatformException("internal", message = "The instance described the App wrongly."),
            slug = view["slug"] as? String ?: "",
            name = view["name"] as? String ?: "",
            runtime = frontend?.get("runtime") as? String,
            packageBuild = int(frontend?.get("packageBuild")),
            deploymentId = view["currentDeploymentId"] as? String,
            rpcMethods = methods,
            hasData = (view["capabilities"] as? List<*>)?.contains("dataTable") == true,
        )
    }

    fun runtimeTrust(): RuntimeTrust {
        val trust = unary("hatch.platform.v1.AppService", "GetAppRuntimeTrust")["trust"] as? Map<*, *>
        return RuntimeTrust(
            initialized = trust?.get("initialized") == true,
            roots = (trust?.get("roots") as? List<*>)?.mapNotNull { (it as? Map<*, *>)?.get("publicKey") as? String } ?: emptyList(),
            revocations = (trust?.get("revocations") as? Map<*, *>)?.get("signed") as? String,
        )
    }

    /** Minutes a hidden App keeps running (`GetDeskPreferences`). */
    fun backgroundAppMinutes(): Int? =
        int((unary("hatch.platform.v1.PreferenceService", "GetDeskPreferences")["preferences"] as? Map<*, *>)?.get("backgroundAppMinutes"))

    /** Downloads the App's live signed package and writes it, whole and verified, to `file`. */
    fun downloadPackage(appId: String, file: File, hasher: PackageHasher): AppPackageInfo {
        val response =
            transport.send(
                HttpRequest(
                    "POST",
                    url("hatch.platform.v1.AppService", "GetAppPackage"),
                    headers("application/connect+json"),
                    envelope(Json.stringify(mapOf("id" to appId)).toByteArray()),
                    timeoutMillis = 120_000,
                )
            )
        if (response.status !in 200..299) {
            throw error(runCatching { Json.parse(String(response.body)) as? Map<*, *> }.getOrNull(), response.status)
        }
        val (info, bytes) = readPackage(response.body, hasher)
        if (info.appId != appId) throw PlatformException("internal", message = "The instance sent another App's package.")
        file.parentFile?.mkdirs()
        val partial = File(file.parentFile, "${file.name}.partial")
        partial.writeBytes(bytes)
        if (!partial.renameTo(file)) {
            partial.delete()
            throw PlatformException("internal", message = "Could not keep the package.")
        }
        return info
    }
}
