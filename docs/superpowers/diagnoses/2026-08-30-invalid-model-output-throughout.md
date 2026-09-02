# 诊断报告:`INVALID_MODEL_OUTPUT：模型未返回此句的解析结果`

- **日期**:2026-08-30
- **触发句**:`Claude uses tools throughout, whether searching files to understand your code, editing to make changes, or running tests to check its work.`
- **复现环境**:真 Chrome(headless)加载 dist 扩展 → 真弹窗启动会话 → 计数代理转发本机 Ollama `qwen3.5:9b` 与 DeepSeek `deepseek-v4-flash`,两路都稳定复现。
- **诊断脚本**:`.superpowers/acceptance/real-chrome/diag-missing-result.mjs`(gitignore,永不提交;复现命令见附录)。

## 一句话结论

**`throughout` 被 `PREPOSITIONS` 介词白名单误收。** 在触发句里它是**副词**(「自始至终」,修饰 `uses`,后面跟的是逗号、没有宾语),模型把它单独标成 `ADVERBIAL` 是**正确**的分析;但校验器只看「单词成分 + 命中白名单」就按「介词不得独立成段」拒绝,修复轮的错误文案本身是错的,模型无从修复,两轮不过后整句判死,页面显示兜底文案。

## 失败链路(逐环)

```
模型输出(合法 JSON,句 ID 齐全,唯一"违规"是 throughout 单独成段)
  ↓ validateCoreBatch
PREPOSITIONS.has("throughout") = true → 误报 "a preposition must be merged with the phrase it governs"
  ↓ 首轮无效,进修复轮
buildRepairPrompt 把这条错误文案原样塞进 prompt(它同时是修复指令)
  ↓ 模型读了指令
"throughout 不是介词,是副词" → 指令与事实矛盾,模型不执行(实测两轮原样保留 token 3)
  ↓ 修复轮仍不过
该句进 outcome.failures = { sentenceId, error: INVALID_MODEL_OUTPUT("…仍不合格:<校验错误摘要>") }
  ↓ service-worker.ts 成功路径只回传 outcome.result,丢弃 failures(仅探测 AUTH_FAILED)
content 侧:句子不在 analyses 里、无批级 error
  ↓ responseErrorMessage() 兜底
页面显示「INVALID_MODEL_OUTPUT：模型未返回此句的解析结果」
```

## 证据

诊断脚本对账了每趟请求的「prompt 捎的句 ID ↔ 输出的句 ID」,排除了截断、JSON 不合法、句 ID 错位三类嫌疑——两路模型的输出 JSON 均合法、句 ID 均齐全,死因全部在校验环节。

### 证据 1:代理账本(DeepSeek v4-flash)

```
[0] probe  status=400  → json_schema 被拒,降级重试(预期行为)
[1] probe  status=200  → 降级成功
[2] core   捎 2 句 → 输出 2 句(句 ID 齐全)         ← JSON 完全合法
[3] core-repair 捎 1 句 → 输出 1 句                  ← 修复轮后仍被拒
```

修复轮 prompt 携带的首轮校验错误(两条,其一为误报):

```json
[
  {"path":"sentences[0].components[4]","message":"CONJUNCTION must cover a coordinating conjunction (for, and, nor, but, or, yet, so)"}
]
```

模型修复轮把 `whether` 从 `CONJUNCTION` 并进了 `ADVERBIAL`(响应了那条**真实**的错误)。

### 证据 2:修复轮输出喂 validator(单元级复现)

把 DeepSeek 修复轮的**原样输出**直接喂 `validateCoreBatch`,结果恰好一条错误:

```json
[
  {"path":"sentences[0].components[3]","message":"a preposition must be merged with the phrase it governs instead of forming its own component"}
]
```

`components[3]` = `{startToken:3, endToken:3, role:"ADVERBIAL", translation:"全程"}`——正是 `throughout` 单独成段这一项,其余全部通过。

### 证据 3:对照组(钉死是白名单、不是句法)

同一 token 位置、同一结构,只把 `throughout` 换成 `everywhere`(不在 `PREPOSITIONS` 里,同样是副词):

| 方案 | 校验结果 |
|---|---|
| `throughout` 单独成 `ADVERBIAL`(模型原输出) | ❌ 拒("preposition must be merged") |
| 把 `throughout` 并入前段 `OBJECT`(tools throughout) | ✅ 过 |
| `everywhere` 单独成 `ADVERBIAL`(其余完全同构) | ✅ 过 |

第三个对照证明:拒绝的**唯一动因**是词在白名单里,与句子结构无关。

### 证据 4:qwen3.5:9b 路线的死因(顺带钉死)

本地 9B 的失败原因不同,但同样卡在修复轮:首轮输出 `COORDINATE_CLAUSE`(恰好 1 个,硬门拒)+ `PREDICATE` 覆盖 token 3–9 吞掉宾语 `each response`(限定词硬门拒);修复轮改掉了 `COORDINATE_CLAUSE`,**`PREDICATE` 3–9 原样照抄**——校验错误明确要求"emit the noun phrase as its own OBJECT",模型未执行。属于"模型能力不足 + 修复轮修复率低"的已知取舍,拒绝本身是合理的。

## 根因定位(代码级)

```ts
// chrome-plugin/src/language/analysis-validator.ts PREPOSITIONS
"throughout",   // ← 误收

// 判定逻辑(分析器只看词,不看语境)
if (component.role !== GrammarRole.CONJUNCTION &&
    words.length === 1 &&
    PREPOSITIONS.has(words[0])) {   // throughout 命中 → 拒
  addError(..., "a preposition must be merged with the phrase it governs ...");
}
```

白名单注释自述的收录标准是「只收**缺少宾语时几乎不可能**独立作副词、表语或连词的词」,并把 `after/before/down/off/over/since/until/around/inside/outside` 等兼类词刻意排除、注明「误拒比误放更糟」。`throughout` 恰好违反这条标准——它的副词用法极常见(`uses tools throughout` / `throughout the process` 两用),收录它正是注释里警告的那种"把合法分析送进无意义修复轮"。

Kotlin 侧同源同坑:`intellij-plugin/.../language/AnalysisValidator.kt` 的 `prepositions` 集合同样含 `"throughout"`。

## 问题清单(按优先级)

| # | 问题 | 性质 | 位置 |
|---|---|---|---|
| 1 | `throughout` 误入介词白名单,**本句直接死因** | 词表 bug,TS/Kotlin 双端 | `analysis-validator.ts` / `AnalysisValidator.kt` |
| 2 | SW 成功路径丢弃 `outcome.failures`,失败句只显示兜底文案,真实校验错误不可见 | 可诊断性缺口 | `service-worker.ts` 成功分支 |
| 3 | 修复轮对结构类错误(限定词/介词/FANBOYS)修复率低,一次机会用完即判死 | 已知设计取舍,可另议 | `analysis-service.ts` repair pass |

## 修复建议

1. **主修(最小正确)**:把 `throughout` 从 TS 与 Kotlin 双端白名单移出。理由:与被排除的 `after/before` 同类(兼类词),符合注释自述的收录标准;`core-gold-annotations.test.ts` 黄金集整份过一遍确认无回归。
2. **建议同步(可选)**:问题 2 的 `failures` 透传(协议三处同步:`protocol.ts` 类型 + SW 构造 + content 侧 `isRuntimeResponse` case),让失败句显示真实校验错误,下次排查不用再跑真机诊断。

## 附:复现命令

```bash
# 本地 Ollama
node .superpowers/acceptance/real-chrome/diag-missing-result.mjs qwen3.5:9b

# DeepSeek(密钥只从 ~/.secrets 环境变量读,经代理注入,不进日志)
source ~/.secrets && export UPSTREAM=https://api.deepseek.com UPSTREAM_KEY=$DEEPSEEK_API_KEY \
  && node .superpowers/acceptance/real-chrome/diag-missing-result.mjs deepseek-v4-flash

# 单元级:修复轮输出原样喂 validator(探针测试,验证后已删,可按证据 2 重建)
```

### 顺带确认的环境事实

- DeepSeek 旧模型名 `deepseek-chat` 已 404 下线,现行模型:`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`。
- DeepSeek 对 `response_format: {type:"json_schema"}` 拒绝状态码为 HTTP **400**,走 probe 的既有降级路径(`UnsupportedResponseFormatError` → `persistJsonSchemaSupport("unsupported")` → 无 schema 重试)正常,账本里 probe 两次即降级成功,非本次问题。
