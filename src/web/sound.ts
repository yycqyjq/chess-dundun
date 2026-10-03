/**
 * 音效：WebAudio 现场合成几个极短的音，不引任何素材文件。
 * 浏览器不给「没交互就出声」，所以 AudioContext 到第一次点按才建；建不起来就整体哑掉，不影响打牌。
 */
export type Cue = 'pick' | 'flip' | 'play' | 'pledge' | 'collect' | 'win';

/** 每个音：频率序列（Hz）、单个音多长（秒）、波形 */
const VOICES: Record<Cue, { freqs: number[]; each: number; type: OscillatorType; gain: number }> = {
  pick: { freqs: [520], each: 0.05, type: 'triangle', gain: 0.1 },
  flip: { freqs: [300, 620], each: 0.06, type: 'triangle', gain: 0.14 },
  play: { freqs: [420], each: 0.07, type: 'square', gain: 0.07 },
  pledge: { freqs: [240, 170], each: 0.08, type: 'sine', gain: 0.16 },
  collect: { freqs: [520, 780], each: 0.08, type: 'sine', gain: 0.16 },
  win: { freqs: [523, 659, 784, 1047], each: 0.11, type: 'sine', gain: 0.18 },
};

const KEY = 'chess-dundun:sound';

/**
 * 无痕模式的 Safari 一碰 localStorage 就抛（不是返回 null）。
 * 这儿是开桌第一下就碰它，没兜住的话整张桌白屏，所以读写各包一层。
 */
function remembered(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(value: 'on' | 'off'): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // 记不住就这一局管用，下次开桌默认响
  }
}

export class Sound {
  private ctx: AudioContext | null = null;
  private broken = false;
  private on = remembered() !== 'off';

  get enabled(): boolean {
    return this.on;
  }

  /** 顶栏那个开关：翻一下状态并记住，别下次开桌又响了 */
  toggle(): boolean {
    this.on = !this.on;
    remember(this.on ? 'on' : 'off');
    if (this.on) this.cue('pick');
    return this.on;
  }

  /**
   * 在真手势里把 AudioContext 建起来／唤醒。浏览器只认「用户按的那一下」，
   * 等动画帧里第一声才建，多半已经被自动播放策略按住——默认开着却一声不响，直到人手动拨一次开关。
   */
  warmup(): void {
    this.context();
  }

  cue(cue: Cue): void {
    if (!this.on || this.broken) return;
    const voice = VOICES[cue];
    const ctx = this.context();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    voice.freqs.forEach((f, i) => {
      const at = t0 + i * voice.each;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = voice.type;
      osc.frequency.setValueAtTime(f, at);
      // 快起快落：一敲就走，别拖成背景音盖住下一声
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(voice.gain, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + voice.each * 0.95);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + voice.each);
    });
  }

  private context(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    try {
      this.ctx = new AudioContext();
      return this.ctx;
    } catch {
      // 没有 AudioContext（老 Safari 前几个版本、或者被策略挡了）就当这游戏没声音
      this.broken = true;
      return null;
    }
  }
}
