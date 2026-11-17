// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  createSpeaker,
  pickEnglishVoice,
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
    expect(synth.spoken[0]!.voice?.name).toBe("Samantha");
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
    speaker!.speak("a");
    speaker!.stop();
    expect(ends).toHaveLength(1);
    expect(synth.cancelCount).toBe(1);
    expect(speaker!.isSpeaking()).toBe(false);
    speaker!.stop();
    expect(ends).toHaveLength(1);
    expect(synth.cancelCount).toBe(1);
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
});

describe("pickEnglishVoice", () => {
  it("排序:en-US 本地 > en-US 网络 > 其他 en 本地;同档按 name 字典序", () => {
    const voices = [
      voice("en-GB", "Daniel", true),
      voice("en-US", "Google US English", false),
      voice("en-US", "Samantha", true),
      voice("zh-CN", "Tingting", true),
      voice("en-US", "Ava", true),
    ];
    expect(pickEnglishVoice(voices)?.name).toBe("Ava");
    expect(pickEnglishVoice(voices.filter((v) => v.name !== "Ava"))?.name).toBe("Samantha");
    expect(
      pickEnglishVoice(voices.filter((v) => v.name !== "Ava" && v.name !== "Samantha"))?.name,
    ).toBe("Google US English");
  });

  it("无 en 语音或空列表返回 undefined", () => {
    expect(pickEnglishVoice([])).toBeUndefined();
    expect(pickEnglishVoice([voice("zh-CN", "Tingting", true)])).toBeUndefined();
  });
});
