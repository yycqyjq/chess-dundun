import type { Piece } from '../core/pieces.ts';
import type { Placed } from './board.ts';

/** 一张牌挪位的时长。发牌时按序号错开，看起来就是一张一张码出去的 */
export const MOVE_MS = 300;

/** 牌面上只刻一个字，红黑靠字色分；全名（红车/黑车）留给文字界面 */
function faceGlyph(piece: Piece): string {
  return piece.label.replace(/^[红黑]/, '');
}

/**
 * 32 枚棋子的 DOM 层。位置全走 transform（不碰 left/top），
 * 上一帧的坐标自己记着，状态一变就能补间过去，不用读 getBoundingClientRect。
 */
export class Pieces {
  private els = new Map<number, HTMLElement>();
  private at = new Map<number, Placed>();

  constructor(root: HTMLElement, pieces: Piece[]) {
    for (const p of pieces) {
      const el = document.createElement('div');
      el.className = 'piece';
      el.dataset.id = String(p.id);
      el.dataset.color = p.color;
      const turn = document.createElement('div');
      turn.className = 'turn';
      const face = document.createElement('div');
      face.className = 'face';
      face.textContent = faceGlyph(p);
      const back = document.createElement('div');
      back.className = 'back';
      turn.append(face, back);
      el.append(turn);
      el.hidden = true;
      this.els.set(p.id, el);
      root.append(el);
    }
  }

  /** 联机里牌名是分批到的：扣棋一墩打完才翻，翻开那一下这份快照才带着字。位置归 place，牌面归这儿 */
  paint(deck: Piece[]): void {
    for (const p of deck) {
      if (!p.label) continue;
      const el = this.els.get(p.id);
      if (!el) continue;
      const glyph = faceGlyph(p);
      const face = el.querySelector<HTMLElement>('.face')!;
      if (face.textContent === glyph && el.dataset.color === p.color) continue;
      face.textContent = glyph;
      el.dataset.color = p.color;
    }
  }

  /** 桌面尺寸变了要重算：位置照样落，但不补间，不然整桌牌拖成一片残影 */
  place(plan: Map<number, Placed>, animate: boolean): void {
    const from = this.at;
    this.at = new Map();
    for (const el of this.els.values()) el.hidden = true;
    for (const [id, p] of plan) {
      const el = this.els.get(id)!;
      el.hidden = false;
      el.classList.toggle('down', p.down);
      el.classList.remove('sel', 'hint', 'won', 'drawn', 'ontable', 'pledge', 'pile', 'best', 'hand', 'pick', 'dim', 'stack', 'spread');
      for (const c of p.cls.split(' ')) if (c) el.classList.add(c);
      el.style.zIndex = String(p.z);
      const was = animate ? from.get(id) : undefined;
      this.at.set(id, p);
      const at = (q: Placed, x: number, y: number) =>
        `translate(${x}px, ${y}px) rotate(${q.rot}deg) scale(${q.scale})`;
      // 挪位、转正、放大都算「这一帧和上一帧不一样」，都得补间——摸签「抽出」只改缩放，
      // 光比坐标的话那一下会变成瞬间弹大
      const moved =
        was !== undefined &&
        (Math.abs(was.x - p.x) >= 0.5 ||
          Math.abs(was.y - p.y) >= 0.5 ||
          Math.abs(was.rot - p.rot) >= 0.5 ||
          Math.abs(was.scale - p.scale) >= 0.005);
      if (!was || !moved) {
        el.style.transition = '';
        el.style.transform = at(p, p.x, p.y);
        continue;
      }
      // FLIP：先按上一帧的样子摆回去，撑过一帧再放开过渡补间到这一帧
      el.style.transition = 'none';
      el.style.transform = at(was, was.x, was.y);
      void el.offsetWidth;
      el.style.transition = `transform ${MOVE_MS}ms cubic-bezier(.2,.75,.25,1) ${p.delay}ms`;
      el.style.transform = at(p, p.x, p.y);
      el.addEventListener(
        'transitionend',
        () => {
          el.style.transition = '';
        },
        { once: true },
      );
    }
  }
}
