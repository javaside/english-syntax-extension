package dev.codetui.englishsyntax.scheduler

import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.newSingleThreadContext
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import java.util.concurrent.atomic.AtomicInteger

class RequestSchedulerTest {
  private fun request(
    documentId: String = "doc-1",
    cacheKey: String = "key",
    priority: SchedulerPriority = SchedulerPriority.ACTIVE_VISIBLE_CORE,
    sentenceCount: Int = 1,
    jumpQueue: Boolean = false,
  ) = ScheduledRequest(cacheKey, documentId, priority, sentenceCount, jumpQueue)

  private suspend fun waitUntil(timeoutMs: Long = 2_000, condition: () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition() && System.currentTimeMillis() < deadline) delay(10)
  }

  @Test
  fun `orders all five priority classes`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 5)
    scheduler.pauseAll()
    val order = java.util.Collections.synchronizedList(mutableListOf<SchedulerPriority>())
    val priorities = listOf(
      SchedulerPriority.ACTIVE_PREFETCH_CORE,
      SchedulerPriority.OTHER_VISIBLE_CORE,
      SchedulerPriority.ACTIVE_VISIBLE_CORE,
      SchedulerPriority.DETAIL_CLICK,
      SchedulerPriority.USER_RETRY,
    )
    coroutineScope {
      for (priority in priorities) {
        launch {
          scheduler.schedule(request(priority = priority, cacheKey = "k-${priority.name}")) { order += priority }
        }
      }
      delay(50)
      scheduler.resumeAll()
    }
    assertEquals(
      listOf(
        SchedulerPriority.USER_RETRY,
        SchedulerPriority.DETAIL_CLICK,
        SchedulerPriority.ACTIVE_VISIBLE_CORE,
        SchedulerPriority.OTHER_VISIBLE_CORE,
        SchedulerPriority.ACTIVE_PREFETCH_CORE,
      ),
      order.toList(),
    )
  }

  @Test
  fun `repair jumps only inside the same priority`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 1)
    scheduler.pauseAll()
    val order = java.util.Collections.synchronizedList(mutableListOf<String>())
    // 单线程 dispatcher 保证四个 schedule 调用按代码顺序入队（入队后即挂起等 deferred）。
    val enqueueScope = CoroutineScope(newSingleThreadContext("enqueue") + Job())
    val jobs = listOf(
      enqueueScope.async { scheduler.schedule(request(cacheKey = "normal-1")) { order += "normal-1" } },
      enqueueScope.async { scheduler.schedule(request(cacheKey = "repair", jumpQueue = true)) { order += "repair" } },
      enqueueScope.async { scheduler.schedule(request(cacheKey = "normal-2")) { order += "normal-2" } },
      enqueueScope.async {
        scheduler.schedule(request(cacheKey = "higher", priority = SchedulerPriority.USER_RETRY)) { order += "higher" }
      },
    )
    // 等四个都真正进入队列（挂起在 deferred.await 上）再恢复调度。
    waitUntil { true }
    delay(100)
    scheduler.resumeAll()
    jobs.awaitAll()
    assertEquals(listOf("higher", "repair", "normal-1", "normal-2"), order.toList())
    enqueueScope.cancel()
  }

  @Test
  fun `one scheduled item occupies one slot`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 2)
    val gate = CompletableDeferred<Unit>()
    val started = java.util.Collections.synchronizedList(mutableListOf<String>())
    coroutineScope {
      launch { scheduler.schedule(request(cacheKey = "a")) { started += "a"; gate.await() } }
      launch { scheduler.schedule(request(cacheKey = "b")) { started += "b"; gate.await() } }
      launch { scheduler.schedule(request(cacheKey = "c")) { started += "c" } }

      waitUntil { started.size >= 2 }
      assertEquals(2, started.size)
      assertFalse(started.contains("c"))

      gate.complete(Unit)
      waitUntil { started.contains("c") }
      assertTrue(started.contains("c"))
    }
  }

  @Test
  fun `background work leaves one of four slots free`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 4, backgroundConcurrency = 3)
    val gate = CompletableDeferred<Unit>()
    val started = java.util.Collections.synchronizedList(mutableListOf<String>())
    coroutineScope {
      for (i in 1..4) {
        launch {
          scheduler.schedule(request(cacheKey = "bg-$i", priority = SchedulerPriority.ACTIVE_PREFETCH_CORE)) {
            started += "bg-$i"
            gate.await()
          }
        }
      }
      waitUntil { started.size >= 3 }
      assertEquals(3, started.size)

      launch { scheduler.schedule(request(cacheKey = "interactive")) { started += "interactive" } }
      waitUntil { started.contains("interactive") }
      assertTrue(started.contains("interactive"))

      gate.complete(Unit)
      waitUntil { started.size == 5 }
    }
  }

  @Test
  fun `deduplicates document and cache key`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 4)
    val calls = AtomicInteger()
    val gate = CompletableDeferred<Unit>()
    coroutineScope {
      launch { scheduler.schedule(request()) { calls.incrementAndGet(); gate.await() } }
      launch { scheduler.schedule(request()) { calls.incrementAndGet(); gate.await() } }
      delay(50)
      assertEquals(1, calls.get())

      gate.complete(Unit)
      launch { scheduler.schedule(request(documentId = "doc-2")) { calls.incrementAndGet() } }.join()
      assertEquals(2, calls.get())
    }
  }

  @Test
  fun `rejects more than six sentences`() = runBlocking {
    val scheduler = RequestScheduler()
    val error = runCatching { scheduler.schedule(request(sentenceCount = 7)) { "x" } }
      .exceptionOrNull() as ExtensionFailure
    assertEquals(ErrorCode.SENTENCE_TOO_LONG, error.code)
  }

  @Test
  fun `retries retryable errors twice with exponential delay`() = runBlocking {
    val attempts = AtomicInteger()
    val scheduler = RequestScheduler(concurrency = 1, retryDelayMillis = { 10L }, jitterMillis = { 0L })
    val result = scheduler.schedule(request()) {
      if (attempts.incrementAndGet() <= 2) throw ExtensionFailure(ErrorCode.NETWORK_ERROR, "flaky", true)
      "ok"
    }
    assertEquals("ok", result)
    assertEquals(3, attempts.get())
  }

  @Test
  fun `uses retry after for rate limit`() = runBlocking {
    val attempts = AtomicInteger()
    val scheduler = RequestScheduler(concurrency = 1, retryDelayMillis = { 1_000L }, jitterMillis = { 0L })
    val result = scheduler.schedule(request()) {
      if (attempts.incrementAndGet() == 1) {
        throw ExtensionFailure(
          ErrorCode.RATE_LIMITED,
          "rate limited",
          true,
          mapOf("retryAfterMs" to FailureDetail.NumberValue(20L)),
        )
      }
      "ok"
    }
    assertEquals("ok", result)
    assertEquals(2, attempts.get())
  }

  @Test
  fun `cancel document rejects queued and cancels active`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 1)
    val activeStarted = CompletableDeferred<Unit>()
    val gate = CompletableDeferred<Unit>()
    var activeError: Throwable? = null
    var queuedError: Throwable? = null
    coroutineScope {
      launch {
        try {
          scheduler.schedule(request(cacheKey = "active")) {
            activeStarted.complete(Unit)
            gate.await()
          }
        } catch (error: Throwable) {
          activeError = error
        }
      }
      launch {
        try {
          scheduler.schedule(request(cacheKey = "queued")) { "never" }
        } catch (error: Throwable) {
          queuedError = error
        }
      }
      activeStarted.await()

      scheduler.cancelDocument("doc-1")

      waitUntil { queuedError != null }
      assertEquals(ErrorCode.REQUEST_CANCELLED, (queuedError as ExtensionFailure).code)

      gate.complete(Unit)
      waitUntil { activeError != null }
      assertEquals(ErrorCode.REQUEST_CANCELLED, (activeError as ExtensionFailure).code)
    }
  }

  @Test
  fun `pause blocks only that documents new work`() = runBlocking {
    val scheduler = RequestScheduler(concurrency = 2)
    scheduler.pauseDocument("paused-doc")
    val order = java.util.Collections.synchronizedList(mutableListOf<String>())
    coroutineScope {
      launch {
        scheduler.schedule(request(documentId = "paused-doc", cacheKey = "paused")) { order += "paused" }
      }
      launch {
        scheduler.schedule(request(documentId = "other-doc", cacheKey = "other")) { order += "other" }
      }

      waitUntil { order.contains("other") }
      assertTrue(order.contains("other"))
      assertFalse(order.contains("paused"))

      scheduler.resumeDocument("paused-doc")
      waitUntil { order.contains("paused") }
      assertTrue(order.contains("paused"))
    }
  }
}
