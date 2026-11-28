package dev.hatch.app.core

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/** The real transport against a local server that streams like the Data API. */
class TransportTest {
    private lateinit var server: HttpServer
    private lateinit var base: String

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        // Heartbeats forever, as the events stream does while nothing changes.
        server.createContext("/heartbeats") { exchange ->
            exchange.sendResponseHeaders(200, 0)
            runCatching {
                exchange.responseBody.use { body ->
                    while (true) {
                        body.write(": heartbeat\n\n".toByteArray())
                        body.flush()
                        Thread.sleep(50)
                    }
                }
            }
        }
        server.createContext("/long-line") { exchange ->
            exchange.sendResponseHeaders(200, 0)
            runCatching { exchange.responseBody.use { it.write(ByteArray(HttpTransport.MAX_LINE + 1) { 'x'.code.toByte() }) } }
        }
        server.executor = java.util.concurrent.Executors.newCachedThreadPool()
        server.start()
        base = "http://127.0.0.1:${server.address.port}"
    }

    @AfterTest
    fun stop() {
        server.stop(0)
    }

    @Test
    fun aStreamThatNeverEndsIsClosedAtItsDeadline() {
        val started = System.nanoTime()
        var lines = 0
        val response =
            UrlConnectionTransport().lines(HttpRequest("GET", "$base/heartbeats", timeoutMillis = 30_000), 300) {
                lines += 1
                true
            }
        val elapsed = (System.nanoTime() - started) / 1_000_000
        assertEquals(200, response.status)
        assertTrue(lines > 0)
        // Well before the socket's 30 s read timeout, which heartbeats keep from firing.
        assertTrue(elapsed < 5_000, "took $elapsed ms")
    }

    @Test
    fun anOverlongLineFailsTheRead() {
        assertFailsWith<IOException> {
            UrlConnectionTransport().lines(HttpRequest("GET", "$base/long-line"), 5_000) { true }
        }
    }
}
