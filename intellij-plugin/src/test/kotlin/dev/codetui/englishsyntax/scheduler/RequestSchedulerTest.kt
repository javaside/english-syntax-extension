package dev.codetui.englishsyntax.scheduler

import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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

  private suspend fun waitUntil(timeoutMs: Long = 2_000, condition: suspend () -> Boolean) {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (!condition() && System.currentTimeMillis() < deadline) delay(10)
    require(condition()) { "waitUntil timed out after ${timeoutMs}ms" }
  }

  @Test
  fun `orders all five priority classes`() = runBlocking {
    // concurrency=1：出队顺序即执行顺序，断言五档优先级的完整排序。
    val scheduler = RequestScheduler(concurrency = 1)
    scheduler.pauseAll()
    val order = java.util.Collections.synchronizedList(mutableListOf<SchedulerPriority>())
    val priorities = listOf(
      SchedulerPriority.ACTIVE_PREFETCH_CORE,
      SchedulerPriority.OTHER_VISIBLE_CORE,
      SchedulerPriority.ACTIVE_VISIBLE_CORE,
      SchedulerPriority.DETAIL_CLICK,
      SchedulerPriority.USER_RETRY,
    )
    val jobs = mutableListOf<kotlinx.coroutines.Job>()
    for (priority in priorities) {
      jobs += launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
        scheduler.schedule(request(priority = priority, cacheKey = "k-${priority.name}")) { order += priority }
      }
    }
    waitUntil(timeoutMs = 5_000) { scheduler.queueSizeForTest() == priorities.size }
    scheduler.resumeAll()
    jobs.forEach { it.join() }
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
    // 入队顺序在并发下不严格保证，断言只钉排序规则：更高优先级最先、
    // jumpQueue 修复先于同优先级普通项；两个普通项的相对顺序无关紧要。
    val jobs = mutableListOf<kotlinx.coroutines.Job>()
    jobs += launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
      scheduler.schedule(request(cacheKey = "normal-1")) { order += "normal-1" }
    }
    jobs += launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
      scheduler.schedule(request(cacheKey = "repair", jumpQueue = true)) { order += "repair" }
    }
    jobs += launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
      scheduler.schedule(request(cacheKey = "normal-2")) { order += "normal-2" }
    }
    jobs += launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
      scheduler.schedule(request(cacheKey = "higher", priority = SchedulerPriority.USER_RETRY)) { order += "higher" }
    }
    waitUntil(timeoutMs = 5_000) { scheduler.queueSizeForTest() == 4 }
    scheduler.resumeAll()
    jobs.forEach { it.join() }
    assertEquals("higher", order.first())
    assertEquals("repair", order[1])
    assertEquals(setOf("normal-1", "normal-2"), order.drop(2).toSet())
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
    val bgGate = CompletableDeferred<Unit>()
    val interactiveGate = CompletableDeferred<Unit>()
    val started = java.util.Collections.synchronizedList(mutableListOf<String>())
    // 独立 scope（不继承 runBlocking 的 job，避免 cancel 连坐）：入队协程挂起在
    // deferred.await 上，UNDISPATCHED 让入队段在当前线程直接推进。
    val enqueueScope = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)
    val jobs = mutableListOf<kotlinx.coroutines.Job>()
    for (i in 1..4) {
      jobs += enqueueScope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
        scheduler.schedule(request(cacheKey = "bg-$i", priority = SchedulerPriority.ACTIVE_PREFETCH_CORE)) {
          started += "bg-$i"
          bgGate.await()
        }
      }
    }
    jobs += enqueueScope.launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) {
      scheduler.schedule(request(cacheKey = "interactive")) {
        started += "interactive"
        interactiveGate.await()
      }
    }
    // 终态：3 背景 + 1 交互在飞（各自阻塞在自己的 gate 上，计数稳定），第 4 背景排队。
    waitUntil(timeoutMs = 5_000) { scheduler.activeCountForTest() == 4 && scheduler.queueSizeForTest() == 1 }
    assertEquals(4, scheduler.activeCountForTest())
    assertEquals(1, scheduler.queueSizeForTest())

    bgGate.complete(Unit)
    interactiveGate.complete(Unit)
    jobs.forEach { it.join() }
    assertEquals(4, started.count { it.startsWith("bg-") })
    assertTrue(started.contains("interactive"))
    enqueueScope.cancel()
  }

  private fun independentScope() = CoroutineScope(SupervisorJob() + kotlinx.coroutines.Dispatchers.Default)

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
