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
  /** 真实 DOM 属性可空(清空语音即 null);未挑选语音时不赋值(undefined)。 */
  voice?: SpeechSynthesisVoiceLike | null;
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
 * 已知高质量本地语音名(小写、包含匹配——兼容 "Eddy (英语（美国）)"、"Microsoft
 * Aria Online (Natural)" 一类带前缀/后缀的完整名)。macOS 现代系统语音
 * (Samantha/Ava/Eddy/Flo…)、Windows Natural 语音(Aria/Jenny/Guy…)、以及各平台
 * enhanced/premium 变体。
 */
const PREMIUM_LOCAL_VOICE_NAMES = [
  "samantha",
  "ava",
  "zoe",
  "serena",
  "allison",
  "susan",
  "joana",
  "luciana",
  "paulina",
  "daniel",
  "karen",
  "moira",
  "tessa",
  "fiona",
  "nicky",
  "deirdre",
  "eddy",
  "flo",
  "reed",
  "rocko",
  "sandy",
  "shelley",
  "grandma",
  "grandpa",
  "aria",
  "jenny",
  "guy",
  "michelle",
  "ana",
  "zira",
  "david",
  "brian",
  "emma",
  "ava ",
];

/**
 * novelty 效果音与老式 MacinTalk 语音(Bad News/Bells/Boing/Whisper…与
 * Albert/Fred/Junior/Kathy/Ralph):嘶哑或机器人声,不适合发音查证。2026-11-16
 * 真机实测:「本地优先 + 名字字典序」在 macOS 上选中了 Albert——这就是朗读
 * 嘶哑的根因。
 */
const NOVELTY_OR_LEGACY_VOICE_NAMES = [
  "albert",
  "fred",
  "junior",
  "kathy",
  "ralph",
  "princess",
  "zarvox",
  "trinoids",
  "whisper",
  "wobble",
  "bubbles",
  "bahh",
  "bells",
  "boing",
  "cellos",
  "organ",
  "jester",
  "superstar",
  "bad news",
  "good news",
  "hysterical",
  "deranged",
];

const nameMatches = (name: string, candidates: readonly string[]): boolean => {
  const lower = name.toLowerCase();
  return candidates.some((candidate) => lower.includes(candidate));
};

/**
 * 英文语音挑选(发音查证:音质优先):
 * 1. `Google ` 前缀(Chrome 网络语音,质量最好,需联网);
 * 2. 白名单优质语音(macOS 现代系统语音 / Windows Natural 等);
 * 3. 名单外的网络语音;
 * 4. 名单外的本地语音;
 * 5. novelty/老式黑名单垫底。
 * **名单判定只看名字,不看 `localService`**——macOS Chrome 首次 `getVoices()`
 * 返回的 `localService` 全是 false 占位值,`voiceschanged` 之后才刷新,标志位
 * 在点击时机不可信。质量档压过语言档(清晰的 en-GB 优于嘶哑的 en-US);同档
 * 内 en-US 优先,再按 name 字典序稳定排序。无 en 语音返回 undefined(退回
 * lang 保底)。
 */
export function pickEnglishVoice(
  voices: readonly SpeechSynthesisVoiceLike[],
): SpeechSynthesisVoiceLike | undefined {
  const english = voices.filter((v) => v.lang === "en-US" || v.lang.startsWith("en-"));
  if (english.length === 0) {
    return undefined;
  }
  const qualityRank = (v: SpeechSynthesisVoiceLike): number => {
    if (v.name.startsWith("Google ")) {
      return 0;
    }
    if (nameMatches(v.name, PREMIUM_LOCAL_VOICE_NAMES)) {
      return 1;
    }
    if (nameMatches(v.name, NOVELTY_OR_LEGACY_VOICE_NAMES)) {
      return 4;
    }
    return v.localService ? 3 : 2;
  };
  const langRank = (v: SpeechSynthesisVoiceLike): number => (v.lang === "en-US" ? 0 : 1);
  return [...english].sort(
    (a, b) =>
      qualityRank(a) - qualityRank(b) || langRank(a) - langRank(b) || a.name.localeCompare(b.name),
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
    // 双跳断言受控:真实例的 onend/onerror 是带事件参数的 DOM 签名,窄接口
    // 裁成无参 guard——赋值方向(实现→DOM)与调用方向(DOM→guard,事件实参被
    // 忽略)在运行时都安全,纯类型层面的逆变不兼容只能在这里收口。
    createUtterance: (text) =>
      new window.SpeechSynthesisUtterance(text) as unknown as SpeechSynthesisUtteranceLike,
    // 断言受控:传入方经 createUtterance 拿到的就是真 SpeechSynthesisUtterance
    // (唯一入口),窄接口只是把完整类型裁到门面所需。
    speak: (utterance) => synth.speak(utterance as SpeechSynthesisUtterance),
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
      // 无条件 cancel:页面每个段落块各有一个 Speaker,却共享同一个
      // window.speechSynthesis——只在「自己有 current」时 cancel,会让别的
      // 块的新朗读被 Web Speech API 排队而非立即接管。被取消 utterance 的
      // 晚到 onend 由各自守卫丢弃。
      synth.cancel();
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


/** 云端单例 Speaker:块构造时经 registerHooks 登记各自的结束回调。 */
export interface CloudSpeakerHandle extends Speaker {
  registerHooks(hooks: SpeakerHooks): void;
}

/** 云端合成的结果:音频或失败原因(错误码)。 */
export type CloudSynthesisResult = { audioBase64: string; mime: string } | { error: string };

export interface CloudSpeakerOptions {
  /**
   * 云端失败时的本地兜底构造器。onEnd 由 CloudSpeaker 接线:回落自然结束 =
   * 朗读结束,广播复位各块按钮——没有这根线,本地音播完按钮永远卡在按下态。
   */
  createLocalFallback?: (hooks: SpeakerHooks) => Speaker | null;
  /** 回落发生时通知一次(UI 提示用)。 */
  onFallbackNotice?: (reason: string) => void;
  /** 测试注入 Audio 构造。 */
  createAudio?: () => HTMLAudioElement;
}

/**
 * 云端朗读 Speaker(每 documentId 单例,spec 2026-11-18 裁决):speak 发合成请求,
 * 回来后 Audio 播放,onended/onerror 复位按下态。**代际作废**:新 speak/stop 使
 * 在途请求作废——晚到的音频直接丢弃,绝不叠声、绝不误复位新朗读。失败回落
 * localFallback(本地永远有声);回落在播时 isSpeaking 为真,stop/接管都会先停
 * 掉它——停止语义与纯本地 Speaker 完全一致。
 */
export function createCloudSpeaker(
  synthesize: (text: string) => Promise<CloudSynthesisResult>,
  options: CloudSpeakerOptions = {},
): Speaker {
  const createAudio = options.createAudio ?? (() => new Audio());
  let generation = 0;
  let audio: HTMLAudioElement | null = null;
  let fallbackActive = false;
  // 单例被多个块共享:每个块的 hooks 注册进集合,结束事件广播(复位幂等,DOM 现查)。
  const hooksSet = new Set<SpeakerHooks>();
  const settle = (): void => {
    for (const hooks of hooksSet) hooks.onEnd?.();
  };
  const localFallback =
    options.createLocalFallback?.({
      onEnd: () => {
        // 守卫:被 stop()/新 speak() 主动停掉的回落不再广播(那两处自己收口),
        // 只有「回落自然播完」才复位。
        if (!fallbackActive) return;
        fallbackActive = false;
        settle();
      },
    }) ?? undefined;
  const takeOverFallback = (): void => {
    fallbackActive = false;
    localFallback?.stop();
  };
  const speaker: Speaker = {
    speak(text: string): void {
      generation += 1;
      const mine = generation;
      audio?.pause();
      audio = null;
      takeOverFallback();
      void synthesize(text).then((result) => {
        if (mine !== generation) return; // 晚到作废
        if ("error" in result) {
          options.onFallbackNotice?.(result.error);
          if (localFallback !== undefined) {
            fallbackActive = true;
            localFallback.speak(text);
            return;
          }
          settle(); // 无本地兜底:失败也复位,别让按钮卡在按下态
          return;
        }
        const element = createAudio();
        element.src = `data:${result.mime};base64,${result.audioBase64}`;
        element.onended = () => {
          if (mine !== generation) return;
          settle();
        };
        element.onerror = () => {
          if (mine !== generation) return;
          options.onFallbackNotice?.("audio-decode");
          if (localFallback !== undefined) {
            fallbackActive = true;
            localFallback.speak(text);
            return;
          }
          settle();
        };
        audio = element;
        void element.play();
      });
    },
    stop(): void {
      generation += 1;
      audio?.pause();
      audio = null;
      takeOverFallback();
      settle();
    },
    isSpeaking(): boolean {
      return audio !== null || fallbackActive;
    },
  };
  (speaker as CloudSpeakerHandle).registerHooks = (hooks: SpeakerHooks): void => {
    hooksSet.add(hooks);
  };
  return speaker as CloudSpeakerHandle;
}
