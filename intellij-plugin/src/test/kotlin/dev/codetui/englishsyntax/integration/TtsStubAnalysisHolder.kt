package dev.codetui.englishsyntax.integration

import dev.codetui.englishsyntax.analysis.AnalysisServicePort

/** 朗读链路用不到分析:接口成员全部以 NotImplementedError 兜底,供两个集成测试复用。 */
internal object TtsStubAnalysisHolder {
  val stub: AnalysisServicePort = object : AnalysisServicePort {
    override suspend fun analyzeCore(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      sentences: List<dev.codetui.englishsyntax.domain.SentenceInput>,
      priority: dev.codetui.englishsyntax.scheduler.SchedulerPriority,
      bypassCache: Boolean,
      onStreamedComponent: dev.codetui.englishsyntax.analysis.StreamedComponentSink?,
    ): dev.codetui.englishsyntax.analysis.CoreBatchOutcome = throw NotImplementedError()

    override suspend fun lookupCore(
      sentences: List<dev.codetui.englishsyntax.domain.SentenceInput>,
    ): List<dev.codetui.englishsyntax.domain.CoreAnalysis> = emptyList()

    override suspend fun analyzeDetail(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      sentence: dev.codetui.englishsyntax.domain.SentenceInput,
      core: dev.codetui.englishsyntax.domain.CoreAnalysis,
      focus: dev.codetui.englishsyntax.domain.TokenRange,
      onStreamedStructure: dev.codetui.englishsyntax.analysis.StreamedStructureSink?,
    ): dev.codetui.englishsyntax.analysis.DetailOutcome = throw NotImplementedError()

    override suspend fun lookupDetail(
      sentence: dev.codetui.englishsyntax.domain.SentenceInput,
      focus: dev.codetui.englishsyntax.domain.TokenRange,
    ): dev.codetui.englishsyntax.domain.DetailAnalysis? = null

    override suspend fun chat(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      conversationId: String,
      input: dev.codetui.englishsyntax.domain.SentenceInput,
      core: dev.codetui.englishsyntax.domain.CoreAnalysis,
      history: List<dev.codetui.englishsyntax.model.ChatTurn>,
      question: String,
      onStreamedText: dev.codetui.englishsyntax.analysis.StreamedTextSink?,
    ): String = throw NotImplementedError()

    override suspend fun analyzeWithFeedback(
      profile: dev.codetui.englishsyntax.settings.ModelProfile,
      documentId: String,
      sentence: dev.codetui.englishsyntax.domain.SentenceInput,
      core: dev.codetui.englishsyntax.domain.CoreAnalysis,
      feedback: String,
    ): dev.codetui.englishsyntax.domain.CoreAnalysis = throw NotImplementedError()

    override suspend fun cancelDocument(documentId: String) = Unit
  }
}
