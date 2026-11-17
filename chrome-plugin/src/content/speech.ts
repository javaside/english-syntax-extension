/**
 * 朗读门面:content script 本地 `speechSynthesis` 的窄封装。
 *
 * 为什么不直接在 learning-block 里调 `window.speechSynthesis`:
 * 1. happy-dom(单测)既没有 `speechSynthesis` 也没有 `SpeechSynthesisUtterance`
 *    类,依赖注入是唯一的可测路径;
 * 2. 真机 `speak()` 只接受真 `SpeechSynthesisUtterance` 实例(blink 类型检查),
 *    所以 utterance 的构造也由适配层(`defaultSynthesis`)携带,测试注入 plain
 *    对象即可。
 *
 * 语义(spec:发音查证,点击触发):
 * - `speak(text)` 打断旧朗读立即换新(cancel → speak);
 * - `stop()` 正在朗读时**同步**回调 `onEnd` 再 cancel;
 * - 旧 utterance 在被打断后由浏览器补发的 onend/onerror 被守卫丢弃——只有
 *   「当前」朗读的结束事件才允许清态,否则会把新朗读的按钮视觉态误清掉。
 */

/** 测试注入用的窄语音接口;真实 `SpeechSynthesisVoice` 结构化兼容。 */
export interface SpeechSynthesisVoiceLike {
  readonly lang: string;
  readonly localService: boolean;
  readonly name: string;
}

export interface SpeechSynthesisUtteranceLike {
  readonly text: string;
  lang: string;
  voice?: SpeechSynthesisVoiceLike;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

/** 合成器窄接口:构造能力(createUtterance)随实现注入,见文件头。 */
export interface SpeechSynthesisLike {
  getVoices(): readonly SpeechSynthesisVoiceLike[];
  createUtterance(text: string): SpeechSynthesisUtteranceLike;
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
}

export interface Speaker {
  /** 打断旧朗读(若有)并朗读新文本。 */
  speak(text: string): void;
  /** 停止当前朗读;正在朗读时同步触发一次 `onEnd`。 */
  stop(): void;
  isSpeaking(): boolean;
}

export interface SpeakerHooks {
  /** 朗读结束(自然完成/出错/被 stop/被打断后由守卫放行)时回调,幂等安全。 */
  onEnd?: () => void;
}

/**
 * 英文语音挑选(spec:en-US 保底、本地优先):
 * `lang === "en-US"` > 其他 `en-*`;同档 `localService === true` 优先;再按
 * `name` 字典序稳定排序。无 en 语音返回 undefined(调用方退回 lang 保底)。
 */
export function pickEnglishVoice(
  voices: readonly SpeechSynthesisVoiceLike[],
): SpeechSynthesisVoiceLike | undefined {
  const english = voices.filter((v) => v.lang === "en-US" || v.lang.startsWith("en-"));
  if (english.length === 0) {
    return undefined;
  }
  // 两段式(不可用单一加法权重表达):en-US 整体压倒其他 en,localService 只在
  // 同语言档内优先——否则 en-GB 本地会反超 en-US 网络,与既定口径冲突。
  const langRank = (v: SpeechSynthesisVoiceLike): number => (v.lang === "en-US" ? 0 : 1);
  const localRank = (v: SpeechSynthesisVoiceLike): number => (v.localService ? 0 : 1);
  return [...english].sort(
    (a, b) =>
      langRank(a) - langRank(b) || localRank(a) - localRank(b) || a.name.localeCompare(b.name),
  )[0];
}

/**
 * 读 `window.speechSynthesis`(与 `SpeechSynthesisUtterance` 构造器)。两者缺一
 * 即返回 undefined——调用方(createSpeaker)据此返回 null,UI 隐藏朗读按钮。
 */
export function defaultSynthesis(): SpeechSynthesisLike | undefined {
  if (
    typeof window === "undefined" ||
    window.speechSynthesis === undefined ||
    typeof window.SpeechSynthesisUtterance !== "function"
  ) {
    return undefined;
  }
  const synth = window.speechSynthesis;
  return {
    getVoices: () => synth.getVoices(),
    createUtterance: (text) => new window.SpeechSynthesisUtterance(text),
    speak: (utterance) => synth.speak(utterance),
    cancel: () => synth.cancel(),
  };
}

export function createSpeaker(
  synth: SpeechSynthesisLike | undefined,
  hooks?: SpeakerHooks,
): Speaker | null {
  if (synth === undefined) {
    return null;
  }
  let current: SpeechSynthesisUtteranceLike | null = null;
  const settle = (): void => {
    current = null;
    hooks?.onEnd?.();
  };
  return {
    speak(text: string): void {
      if (current !== null) {
        synth.cancel();
      }
      const utterance = synth.createUtterance(text);
      utterance.lang = "en-US";
      const voice = pickEnglishVoice(synth.getVoices());
      if (voice !== undefined) {
        utterance.voice = voice;
      }
      utterance.onend = () => {
        if (current === utterance) {
          settle();
        }
      };
      utterance.onerror = utterance.onend;
      current = utterance;
      synth.speak(utterance);
    },
    stop(): void {
      if (current === null) {
        return;
      }
      settle();
      synth.cancel();
    },
    isSpeaking(): boolean {
      return current !== null;
    },
  };
}
