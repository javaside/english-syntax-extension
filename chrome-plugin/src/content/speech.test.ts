// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCloudSpeaker,
  createSpeaker,
  pickEnglishVoice,
  type Speaker,
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
    return { text, lang: "", onend: null, onerror: null };
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
  });

  it("sends the text and plays the returned audio; end event fires the current hooks", async () => {
    const sent: string[] = [];
    const ends: number[] = [];
    const speaker = createCloudSpeaker(
      async (text) => {
        sent.push(text);
        return { audioBase64: "aGVsbG8=", mime: "audio/mpeg" };
      },
      { createAudio: () => new FakeAudio() as unknown as HTMLAudioElement },
    );
    speaker.speak("hello world");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(sent).toEqual(["hello world"]);
    expect(FakeAudio.instances[0]!.played).toBe(1);
    FakeAudio.instances[0]!.onended?.();
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
      { createAudio: () => new FakeAudio() as unknown as HTMLAudioElement },
    );
    speaker.speak("first");
    speaker.speak("second");
    await vi.waitFor(() => expect(FakeAudio.instances).toHaveLength(1));
    expect(FakeAudio.instances[0]!.src).toContain("c2Vjb25k");
    releaseFirst?.({ audioBase64: "Zmlyc3Q=", mime: "audio/mpeg" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeAudio.instances).toHaveLength(1); // 晚到的 first 没有播
  });

  it("falls back to the local speaker when the cloud request fails", async () => {
    const local = new FakeSpeaker();
    const notices: string[] = [];
    const speaker = createCloudSpeaker(
      async () => ({ error: "NETWORK_ERROR" as const }),
      {
        createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
        localFallback: local,
        onFallbackNotice: (reason) => notices.push(reason),
      },
    );
    speaker.speak("hello");
    await vi.waitFor(() => expect(local.spoken).toEqual(["hello"]));
    expect(notices).toHaveLength(1);
  });

  it("stop() invalidates the in-flight request", async () => {
    let release: ((value: { audioBase64: string; mime: string }) => void) | undefined;
    const speaker = createCloudSpeaker(
      () => new Promise((resolve) => {
        release = resolve;
      }),
      { createAudio: () => new FakeAudio() as unknown as HTMLAudioElement },
    );
    speaker.speak("pending");
    speaker.stop();
    release?.({ audioBase64: "bGF0ZQ==", mime: "audio/mpeg" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(FakeAudio.instances).toHaveLength(0);
  });
});
