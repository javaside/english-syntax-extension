package dev.codetui.englishsyntax.scheduler

import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.ExtensionFailure
import dev.codetui.englishsyntax.domain.FailureDetail
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class SchedulerPriority {
  USER_RETRY,
  DETAIL_CLICK,
  ACTIVE_VISIBLE_CORE,
  OTHER_VISIBLE_CORE,
  ACTIVE_PREFETCH_CORE,
}

data class ScheduledRequest(
  val cacheKey: String,
  val documentId: String,
  val priority: SchedulerPriority,
  val sentenceCount: Int,
  val jumpQueue: Boolean = false,
)

private val PRIORITY_RANK: Map<SchedulerPriority, Int> = mapOf(
  SchedulerPriority.USER_RETRY to 0,
  SchedulerPriority.DETAIL_CLICK to 1,
  SchedulerPriority.ACTIVE_VISIBLE_CORE to 2,
  SchedulerPriority.OTHER_VISIBLE_CORE to 3,
  SchedulerPriority.ACTIVE_PREFETCH_CORE to 4,
)

private val BACKGROUND_PRIORITIES = setOf(SchedulerPriority.ACTIVE_PREFETCH_CORE)

/**
 * 通用优先级调度器：一请求一槽位。优先级排序、同 key 去重、可重试错误指数退避、
 * 按 document 取消与暂停。已经运行的任务不会被抢占。
 */
class RequestScheduler(
  private val concurrency: Int = 4,
  private val backgroundConcurrency: Int = 3,
  private val maxSentencesPerRequest: Int = 6,
  private val maxRetries: Int = 2,
  private val retryDelayMillis: (attempt: Int) -> Long = { 500L shl it },
  private val jitterMillis: () -> Long = { (0L..100L).random() },
) {
  init {
    require(concurrency > 0) { "Scheduler concurrency must be positive" }
    require(backgroundConcurrency > 0) { "Scheduler backgroundConcurrency must be positive" }
    require(maxSentencesPerRequest > 0) { "Scheduler maxSentencesPerRequest must be positive" }
    require(maxRetries >= 0) { "Scheduler maxRetries must be non-negative" }
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val mutex = Mutex()
  private val queue = ArrayDeque<Item>()
  private val active = mutableMapOf<Job, Item>()
  private val inFlightByKey = mutableMapOf<String, Item>()
  private val pausedDocuments = mutableSetOf<String>()
  private var globallyPaused = false
  private var nextSequence = 0L

  suspend fun <T> schedule(request: ScheduledRequest, run: suspend () -> T): T {
    if (request.sentenceCount <= 0 || request.sentenceCount > maxSentencesPerRequest) {
      throw ExtensionFailure(ErrorCode.SENTENCE_TOO_LONG, "Scheduled request exceeds the sentence limit", false)
    }
    val deferred = CompletableDeferred<T>()
    val key = dedupeKey(request)
    @Suppress("UNCHECKED_CAST")
    val existing = mutex.withLock { inFlightByKey[key]?.deferred as CompletableDeferred<T>? }
    if (existing != null) return existing.await()

    val item = Item(
      request = request,
      sequence = nextSequence++,
      deferred = deferred as CompletableDeferred<Any?>,
      run = run as suspend () -> Any?,
    )
    mutex.withLock {
      queue += item
      inFlightByKey[key] = item
      pump()
    }
    return deferred.await()
  }

  /** 测试可见的排队深度（不含在飞）；用于确定性等待入队完成。 */
  suspend fun queueSizeForTest(): Int = mutex.withLock { queue.size }

  /** 测试可见的在飞任务数；用于断言并发上限与背景槽位。 */
  suspend fun activeCountForTest(): Int = mutex.withLock { active.size }

  suspend fun cancelDocument(documentId: String) {
    mutex.withLock {
      val rejected = queue.filter { it.request.documentId == documentId }
      queue.removeAll(rejected)
      rejected.forEach { item ->
        item.deferred.completeExceptionally(cancellationFailure())
        inFlightByKey.remove(dedupeKey(item.request))
      }
      active.entries.filter { it.value.request.documentId == documentId }.forEach { (job, _) -> job.cancel() }
      pump()
    }
  }

  suspend fun pauseDocument(documentId: String) {
    mutex.withLock { pausedDocuments += documentId }
  }

  suspend fun resumeDocument(documentId: String) {
    mutex.withLock {
      pausedDocuments -= documentId
      pump()
    }
  }

  suspend fun pauseAll() {
    mutex.withLock { globallyPaused = true }
  }

  suspend fun resumeAll() {
    mutex.withLock {
      globallyPaused = false
      pump()
    }
  }

  private fun pump() {
    if (globallyPaused) return
    while (active.size < concurrency && queue.isNotEmpty()) {
      val item = takeNext() ?: return
      launchTask(item)
    }
  }

  private fun takeNext(): Item? {
    queue.sortWith { left, right ->
      val byPriority = PRIORITY_RANK.getValue(left.request.priority) - PRIORITY_RANK.getValue(right.request.priority)
      if (byPriority != 0) {
        byPriority
      } else {
        val byJump = (if (left.request.jumpQueue) 0 else 1) - (if (right.request.jumpQueue) 0 else 1)
        if (byJump != 0) byJump else (left.sequence - right.sequence).toInt()
      }
    }
    val activeBackground = active.values.count { isBackground(it.request) }
    val index = queue.indexOfFirst { item ->
      if (item.request.documentId in pausedDocuments) return@indexOfFirst false
      if (isBackground(item.request) && activeBackground >= backgroundConcurrency) return@indexOfFirst false
      true
    }
    if (index == -1) return null
    return queue.removeAt(index)
  }

  private fun launchTask(item: Item) {
    scope.launch {
      val job = kotlin.coroutines.coroutineContext[Job]!!
      mutex.withLock { active[job] = item }
      try {
        var attempt = 0
        while (true) {
          try {
            item.deferred.complete(item.run())
            return@launch
          } catch (error: Throwable) {
            if (error is kotlinx.coroutines.CancellationException) throw error
            val failure = error as? ExtensionFailure
            if (failure?.retryable == true && attempt < maxRetries) {
              val delayMs = retryDelayFor(failure, attempt)
              delay(delayMs)
              attempt += 1
            } else {
              item.deferred.completeExceptionally(error)
              return@launch
            }
          }
        }
      } finally {
        mutex.withLock {
          active.remove(job)
          inFlightByKey.remove(dedupeKey(item.request))
          if (!item.deferred.isCompleted) item.deferred.completeExceptionally(cancellationFailure())
          pump()
        }
      }
    }
  }

  private fun retryDelayFor(failure: ExtensionFailure, attempt: Int): Long {
    val retryAfter = (failure.details["retryAfterMs"] as? FailureDetail.NumberValue)?.value?.toLong()
    if (failure.code == ErrorCode.RATE_LIMITED && retryAfter != null) return retryAfter
    return retryDelayMillis(attempt) + jitterMillis()
  }

  private fun dedupeKey(request: ScheduledRequest): String = "${request.documentId}\u0000${request.cacheKey}"

  private fun isBackground(request: ScheduledRequest): Boolean = request.priority in BACKGROUND_PRIORITIES

  private fun cancellationFailure(): ExtensionFailure =
    ExtensionFailure(ErrorCode.REQUEST_CANCELLED, "Scheduled request was cancelled", false)

  private class Item(
    val request: ScheduledRequest,
    val sequence: Long,
    val deferred: CompletableDeferred<Any?>,
    val run: suspend () -> Any?,
  )
}
