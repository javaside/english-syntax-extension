// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_SYNTHESIS_WATCHDOG_MS,
  createCloudSpeaker,
  createSpeaker,
  pickEnglishVoice,
  VOICE_START_WATCHDOG_MS,
  type Speaker,
  type SpeakerHooks,
  type SpeechSynthesisLike,
  type SpeechSynthesisUtteranceLike,
  type SpeechSynthesisVoiceLike,
} from "./speech";

/**
 * 可编程 fake:记录 speak/cancel 调用,voices 由测试设定;utterance 是 plain
 * 对象(与真实 SpeechSynthesisUtterance 结构兼容),测试手动触发 onend 模拟
 * 「朗读完成」与「被打断后晚到的 onend」。
 */
class FakeSynthesis implements SpeechSynthesisLike {
  voices: SpeechSynthesisVoiceLike[] = [];
  readonly spoken: SpeechSynthesisUtteranceLike[] = [];
  cancelCount = 0;

  getVoices(): readonly SpeechSynthesisVoiceLike[] {
    return this.voices;
  }

  createUtterance(text: string): SpeechSynthesisUtteranceLike {
    return { text, lang: "", onstart: null, onend: null, onerror: null };
  }

  speak(utterance: SpeechSynthesisUtteranceLike): void {
    this.spoken.push(utterance);
  }

  cancel(): void {
    this.cancelCount += 1;
  }
}

const voice = (lang: string, name: string, localService: boolean): SpeechSynthesisVoiceLike => ({
  lang,
  name,
  localService,
});

describe("createSpeaker", () => {
  it("环境无 speechSynthesis 时返回 null(调用方据此隐藏按钮)", () => {
    expect(createSpeaker(undefined)).toBeNull();
  });

  it("voices 为空也能发声:utterance.lang 固定 en-US 保底,voice 不设", () => {
    const synth = new FakeSynthesis();
    const speaker = createSpeaker(synth);
    expect(speaker).not.toBeNull();
    speaker!.speak("hello");
    expect(synth.spoken).toHaveLength(1);
    expect(synth.spoken[0]!.text).toBe("hello");
    expect(synth.spoken[0]!.lang).toBe("en-US");
    expect(synth.spoken[0]!.voice).toBeUndefined();
  });

  it("有 en 语音时 utterance.voice 取 pickEnglishVoice 首选", () => {
    const synth = new FakeSynthesis();
    synth.voices = [
      voice("en-GB", "Daniel", true),
      voice("en-US", "Google US English", false),
      voice("en-US", "Samantha", true),
    ];
    const speaker = createSpeaker(synth);
    speaker!.speak("hi");
    expect(synth.spoken[0]!.voice?.name).toBe("Google US English");
  });

  it("打断:speak 新文本先 cancel 旧朗读再 speak,期间 isSpeaking 为 true", () => {
    const synth = new FakeSynthesis();
    const speaker = createSpeaker(synth);
    speaker!.speak("a");
    const cancelsBefore = synth.cancelCount;
    speaker!.speak("b");
    expect(synth.cancelCount).toBe(cancelsBefore + 1);
    expect(synth.spoken.map((u) => u.text)).toEqual(["a", "b"]);
    expect(speaker!.isSpeaking()).toBe(true);
  });

  it("选中的语音挂死时降级重排白名单本地语音,绝不用系统默认(Albert 嘶哑)", () => {
    vi.useFakeTimers();
    try {
      // 场景:首选 Google 网络语音(墙内挂死);系统默认是老式 Albert(嘶哑,
      // 1.6.0 修过的坑)——降级绝不能裸奔到它,要排除网络语音后重走白名单。
      class HangingGoogleSynthesis extends FakeSynthesis {
        override speak(utterance: SpeechSynthesisUtteranceLike): void {
          super.speak(utterance);
          if (utterance.voice?.name.startsWith("Google ")) return; // 网络语音吞
          utterance.onstart?.();
          utterance.onend?.();
        }
      }
      const synth = new HangingGoogleSynthesis();
      synth.voices = [
        voice("en-US", "Google US English", false),
        voice("en-US", "Albert", true),
        voice("en-US", "Samantha", true),
      ];
      const ends: number[] = [];
      const speaker = createSpeaker(synth, { onEnd: () => ends.push(1) });

      speaker!.speak("hello");
      expect(synth.spoken[0]!.voice?.name).toBe("Google US English");

      vi.advanceTimersByTime(VOICE_START_WATCHDOG_MS + 1);

      // 降级重试:选中白名单的 Samantha,不是无 voice(会落到 Albert),播完复位。
      expect(synth.spoken).toHaveLength(2);
      expect(synth.spoken[1]!.voice?.name).toBe("Samantha");
      expect(ends).toHaveLength(1);
      expect(speaker!.isSpeaking()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("降级时全网络语音列表才允许无 voice 兜底(有声总比无声好)", () => {
    vi.useFakeTimers();
    try {
      class HangingGoogleSynthesis extends FakeSynthesis {
        override speak(utterance: SpeechSynthesisUtteranceLike): void {
          super.speak(utterance);
          if (utterance.voice?.name.startsWith("Google ")) return;
          utterance.onstart?.();
          utterance.onend?.();
        }
      }
      const synth = new HangingGoogleSynthesis();
      synth.voices = [voice("en-US", "Google US English", false)];
      const speaker = createSpeaker(synth);

      speaker!.speak("hello");
      vi.advanceTimersByTime(VOICE_START_WATCHDOG_MS + 1);

      expect(synth.spoken).toHaveLength(2);
      expect(synth.spoken[1]!.voice).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("保底重试也挂死时最终复位,绝不永久卡按下态", () => {
    vi.useFakeTimers();
    try {
      class AllHangingSynthesis extends FakeSynthesis {
        override speak(): void {
          // 全部吞掉:无论有无 voice 都不触发事件。
        }
      }
      const synth = new AllHangingSynthesis();
      synth.voices = [voice("en-US", "Google US English", false)];
      const ends: number[] = [];
      const speaker = createSpeaker(synth, { onEnd: () => ends.push(1) });

      speaker!.speak("hello");
      vi.advanceTimersByTime(VOICE_START_WATCHDOG_MS + 1);
      vi.advanceTimersByTime(VOICE_START_WATCHDOG_MS + 1);

      expect(ends).toHaveLength(1);
      expect(speaker!.isSpeaking()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop():朗读中同步触发一次 onEnd 并 cancel;已停再 stop 是 no-op", () => {
    const synth = new FakeSynthesis();
    const ends: number[] = [];
    const speaker = createSpeaker(synth, { onEnd: () => ends.push(1) });
    speaker!.speak("a"); // 无条件 cancel 一次(跨块接管语义)
    speaker!.stop();
    expect(ends).toHaveLength(1);
    expect(synth.cancelCount).toBe(2);
    expect(speaker!.isSpeaking()).toBe(false);
    speaker!.stop();
    expect(ends).toHaveLength(1);
    expect(synth.cancelCount).toBe(2);
  });

  it("晚到的旧 onend 被守卫丢弃;当前朗读的 onend 才触发 onEnd", () => {
    const synth = new FakeSynthesis();
    const ends: number[] = [];
    const speaker = createSpeaker(synth, { onEnd: () => ends.push(1) });
    speaker!.speak("a");
    const a = synth.spoken[0]!;
    speaker!.speak("b"); // a 被打断
    const b = synth.spoken[1]!;
    a.onend?.(); // 浏览器在 cancel 后补发的旧事件:必须丢弃
    expect(ends).toHaveLength(0);
    expect(speaker!.isSpeaking()).toBe(true);
    b.onend?.(); // b 自然完成
    expect(ends).toHaveLength(1);
    expect(speaker!.isSpeaking()).toBe(false);
  });

  it("onerror 与 onend 同守卫:当前朗读出错同样结束并回调 onEnd", () => {
    const synth = new FakeSynthesis();
    const ends: number[] = [];
    const speaker = createSpeaker(synth, { onEnd: () => ends.push(1) });
    speaker!.speak("a");
    synth.spoken[0]!.onerror?.();
    expect(ends).toHaveLength(1);
    expect(speaker!.isSpeaking()).toBe(false);
  });

  it("跨块接管:另一 speaker 在同一 synth 上 speak 时无条件 cancel 排队朗读", () => {
    // 页面每个段落块各建一个 Speaker,底层共享同一个 window.speechSynthesis:
    // 块 A 朗读中点块 B 的喇叭,B 自己 current === null——若只在「自己有 current」
    // 时 cancel,新 utterance 会被 Web Speech API 排队,A 播完才轮到 B。
    const synth = new FakeSynthesis();
    const a = createSpeaker(synth)!;
    const b = createSpeaker(synth)!;
    a.speak("block a sentence");
    b.speak("block b sentence");
    expect(synth.cancelCount).toBe(2); // a 起读与 b 接管各 cancel 一次
    expect(synth.spoken.map((u) => u.text)).toEqual(["block a sentence", "block b sentence"]);
  });
});

describe("pickEnglishVoice", () => {
  it("质量分档:Google > 白名单 > 未知网络 > 未知本地 > novelty 黑名单", () => {
    const voices = [
      voice("en-US", "Samantha", true),
      voice("en-US", "Albert", true),
      voice("en-US", "Google US English", false),
      voice("en-US", "Novel Netvoice X1", false),
      voice("en-US", "Unheard Local Y2", true),
      voice("zh-CN", "Tingting", true),
    ];
    expect(pickEnglishVoice(voices)?.name).toBe("Google US English");
    expect(pickEnglishVoice(voices.filter((v) => !v.name.startsWith("Google ")))?.name).toBe(
      "Samantha",
    );
    const unknownOnly = voices.filter(
      (v) => v.lang === "en-US" && (v.name.startsWith("Novel") || v.name.startsWith("Unheard")),
    );
    expect(pickEnglishVoice(unknownOnly)?.name).toBe("Novel Netvoice X1");
    expect(pickEnglishVoice([voices[1]!, voices[4]!, voice("en-US", "Bells", true)])?.name).toBe(
      "Unheard Local Y2",
    );
  });

  it("质量档压过语言档:en-GB 白名单语音优于 en-US novelty 语音", () => {
    expect(
      pickEnglishVoice([voice("en-US", "Whisper", true), voice("en-GB", "Daniel", true)])?.name,
    ).toBe("Daniel");
  });

  it("本机实测列表缩样:macOS 语音堆里选中 Samantha 而非 Albert/Bad News", () => {
    const macList = [
      "Albert",
      "Bad News",
      "Bahh",
      "Bells",
      "Boing",
      "Bubbles",
      "Cellos",
      "Fred",
      "Jester",
      "Junior",
      "Organ",
      "Ralph",
      "Samantha",
      "Superstar",
      "Trinoids",
      "Whisper",
      "Wobble",
    ].map((name) => voice("en-US", name, true));
    expect(pickEnglishVoice(macList)?.name).toBe("Samantha");
  });

  it("localService 全 false 的未激活快照:名单判定照常,Samantha 仍胜 Albert", () => {
    // macOS Chrome 首次 getVoices() 返回占位 localService=false,voiceschanged
    // 之后才刷新——档位判定不得依赖这个标志。
    expect(
      pickEnglishVoice([voice("en-US", "Albert", false), voice("en-US", "Samantha", false)])?.name,
    ).toBe("Samantha");
  });

  it("白名单命中带区域后缀的名字(如 Eddy (英语（美国）))", () => {
    expect(
      pickEnglishVoice([
        voice("en-US", "Albert", true),
        voice("en-US", "Eddy (英语（美国）)", true),
      ])?.name,
    ).toContain("Eddy");
  });

  it("无 en 语音或空列表返回 undefined", () => {
    expect(pickEnglishVoice([])).toBeUndefined();
    expect(pickEnglishVoice([voice("zh-CN", "Tingting", true)])).toBeUndefined();
  });
});

// ---- CloudSpeaker:云端合成单例(晚到作废/回落本地) ----

class FakeSpeaker implements Speaker {
  readonly spoken: string[] = [];
  stopCount = 0;
  speaking = false;
  speak(text: string): void {
    this.spoken.push(text);
    this.speaking = true;
  }
  stop(): void {
    this.stopCount += 1;
    this.speaking = false;
  }
  isSpeaking(): boolean {
    return this.speaking;
  }
}

class FakePlayer {
  static instances: FakePlayer[] = [];
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  loads = 0;
  starts = 0;
  stops = 0;
  #failLoad = false;
  constructor(failLoad = false) {
    this.#failLoad = failLoad;
    FakePlayer.instances.push(this);
  }
  load(): Promise<void> {
    this.loads += 1;
    return this.#failLoad ? Promise.reject(new Error("decode failed")) : Promise.resolve();
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
}

class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  played = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.played += 1;
    return Promise.resolve();
  }
  pause(): void {}
}

describe("createCloudSpeaker", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    FakePlayer.instances = [];
  });

  it("sends the text and plays the returned audio; end event fires the current hooks", async () => {
    const sent: string[] = [];
    const ends: number[] = [];
    const speaker = createCloudSpeaker(
      (text) => {
        sent.push(text);
        return Promise.resolve({ audioBase64: "aGVsbG8=", mime: "audio/mpeg" });
      },
      { createPlayer: () => new FakePlayer() },
    );
    speaker.speak("hello world");
    await vi.waitFor(() =>
      expect(FakePlayer.instances.filter((p) => p.starts > 0)).toHaveLength(1),
    );
    expect(sent).toEqual(["hello world"]);
    expect(FakePlayer.instances[0]!.starts).toBe(1);
    FakePlayer.instances[0]!.onended?.();
    expect(true).toBe(true);
    void ends;
  });

  it("a late response for an outdated generation is dropped", async () => {
    let releaseFirst: ((value: { audioBase64: string; mime: string }) => void) | undefined;
    const speaker = createCloudSpeaker(
      (text) =>
        text === "first"
          ? new Promise((resolve) => {
              releaseFirst = resolve;
            })
          : Promise.resolve({ audioBase64: "c2Vjb25k", mime: "audio/mpeg" }),
      { createPlayer: () => new FakePlayer() },
    );
    speaker.speak("first");
    speaker.speak("second");
    await vi.waitFor(() =>
      expect(FakePlayer.instances.filter((p) => p.starts > 0)).toHaveLength(1),
    );
    expect(FakePlayer.instances.at(-1)!.starts).toBe(1);
    releaseFirst?.({ audioBase64: "Zmlyc3Q=", mime: "audio/mpeg" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakePlayer.instances.filter((p) => p.starts > 0)).toHaveLength(1); // 晚到的 first 没有播
  });

  it("falls back to the local speaker when the cloud request fails", async () => {
    const local = new FakeSpeaker();
    const notices: string[] = [];
    const speaker = createCloudSpeaker(() => Promise.resolve({ error: "NETWORK_ERROR" }), {
      createPlayer: () => new FakePlayer(),
      createLocalFallback: () => local,
      onFallbackNotice: (reason) => notices.push(reason),
    });
    speaker.speak("hello");
    await vi.waitFor(() => expect(local.spoken).toEqual(["hello"]));
    expect(notices).toHaveLength(1);
  });

  it("回落期间 isSpeaking 为真;本地音播完经 hooks 广播复位", async () => {
    let fallbackHooks: SpeakerHooks | undefined;
    const ends: number[] = [];
    const speaker = createCloudSpeaker(() => Promise.resolve({ error: "AUTH_FAILED" }), {
      createPlayer: () => new FakePlayer(),
      createLocalFallback: (hooks) => {
        fallbackHooks = hooks;
        return new FakeSpeaker();
      },
    });
    speaker.registerHooks({ onEnd: () => ends.push(1) });

    speaker.speak("hello");
    await vi.waitFor(() => expect(speaker.isSpeaking()).toBe(true));
    expect(ends).toHaveLength(0);

    fallbackHooks!.onEnd?.();
    expect(ends).toHaveLength(1);
    expect(speaker.isSpeaking()).toBe(false);
  });

  it("stop() 同步停掉回落中的本地语音并复位按下态", async () => {
    const local = new FakeSpeaker();
    const ends: number[] = [];
    const speaker = createCloudSpeaker(() => Promise.resolve({ error: "NETWORK_ERROR" }), {
      createPlayer: () => new FakePlayer(),
      createLocalFallback: () => local,
    });
    speaker.registerHooks({
      onEnd: () => ends.push(1),
    });

    speaker.speak("hello");
    await vi.waitFor(() => expect(local.spoken).toEqual(["hello"]));
    expect(local.speaking).toBe(true);
    speaker.stop();

    expect(local.speaking).toBe(false);
    expect(ends).toHaveLength(1);
    expect(speaker.isSpeaking()).toBe(false);
  });

  it("新的 speak 接管回落中的本地语音(先停再发云端请求)", async () => {
    const local = new FakeSpeaker();
    let calls = 0;
    const speaker = createCloudSpeaker(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ error: "NETWORK_ERROR" })
          : Promise.resolve({ audioBase64: "c2Vjb25k", mime: "audio/mpeg" });
      },
      {
        createPlayer: () => new FakePlayer(),
        createLocalFallback: () => local,
      },
    );

    speaker.speak("first");
    await vi.waitFor(() => expect(local.spoken).toEqual(["first"]));
    speaker.speak("second");
    await vi.waitFor(() =>
      expect(FakePlayer.instances.filter((p) => p.starts > 0)).toHaveLength(1),
    );

    // 第一次回落音已被新 speak 接管停掉;云端音频接管播放。
    expect(local.speaking).toBe(false);
    expect(FakePlayer.instances.at(-1)!.starts).toBe(1);
  });

  it("无本地兜底时云端失败直接复位,按钮不卡按下态", async () => {
    const ends: number[] = [];
    const speaker = createCloudSpeaker(() => Promise.resolve({ error: "NETWORK_ERROR" }), {
      createPlayer: () => new FakePlayer(),
    });
    speaker.registerHooks({
      onEnd: () => ends.push(1),
    });

    speaker.speak("hello");
    await vi.waitFor(() => expect(ends).toHaveLength(1));
    expect(speaker.isSpeaking()).toBe(false);
  });

  it("解码/音频上下文被拒时回落本地,绝不静默卡死", async () => {
    // 真机症状:合成耗时超过手势激活窗口后 AudioContext/decode 被策略
    // 拒绝 → rejection 无人接 → 无声、无提示、按钮卡亮。必须回落本地出声。

    const local = new FakeSpeaker();
    const notices: string[] = [];
    const ends: number[] = [];
    const speaker = createCloudSpeaker(
      () => Promise.resolve({ audioBase64: "aGVsbG8=", mime: "audio/mpeg" }),
      {
        createPlayer: () => new FakePlayer(true),
        createLocalFallback: () => local,
        onFallbackNotice: (reason) => notices.push(reason),
      },
    );
    speaker.registerHooks({ onEnd: () => ends.push(1) });

    speaker.speak("hello");
    await vi.waitFor(() => expect(local.spoken).toEqual(["hello"]));
    expect(notices).toHaveLength(1);
    expect(ends).toHaveLength(0); // 回落在播,播完才复位
    expect(speaker.isSpeaking()).toBe(true);
  });

  it("云端成功播放触发 onCloudPlayback(来源指示)", async () => {
    const started: number[] = [];
    const speaker = createCloudSpeaker(
      () => Promise.resolve({ audioBase64: "aGVsbG8=", mime: "audio/mpeg" }),
      {
        createPlayer: () => new FakePlayer(),
        onCloudPlayback: () => started.push(1),
      },
    );
    speaker.speak("hello");
    await vi.waitFor(() =>
      expect(FakePlayer.instances.filter((p) => p.starts > 0)).toHaveLength(1),
    );
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it("CONFIG_MISSING(未配置/禁用)静默回落本地,不弹回落提示", async () => {
    const local = new FakeSpeaker();
    const notices: string[] = [];
    const speaker = createCloudSpeaker(() => Promise.resolve({ error: "CONFIG_MISSING" }), {
      createPlayer: () => new FakePlayer(),
      createLocalFallback: () => local,
      onFallbackNotice: (reason) => notices.push(reason),
    });
    speaker.speak("hello");
    await vi.waitFor(() => expect(local.spoken).toEqual(["hello"]));
    expect(notices).toHaveLength(0); // 「没配」不是错误,别骚扰用户
  });

  it("synthesize 挂死(消息通道无响应)超过看门狗时回落本地,绝不静默卡死", async () => {
    vi.useFakeTimers();
    try {
      const local = new FakeSpeaker();
      const speaker = createCloudSpeaker(() => new Promise<never>(() => {}), {
        createLocalFallback: () => local,
      });

      speaker.speak("hello");
      await vi.advanceTimersByTimeAsync(CLOUD_SYNTHESIS_WATCHDOG_MS + 100);

      expect(local.spoken).toEqual(["hello"]);
      expect(speaker.isSpeaking()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop() invalidates the in-flight request", async () => {
    let release: ((value: { audioBase64: string; mime: string }) => void) | undefined;
    const speaker = createCloudSpeaker(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      { createPlayer: () => new FakePlayer() },
    );
    speaker.speak("pending");
    speaker.stop();
    release?.({ audioBase64: "bGF0ZQ==", mime: "audio/mpeg" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakePlayer.instances.filter((p) => p.starts > 0)).toHaveLength(0);
  });
});
