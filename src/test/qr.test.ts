/**
 * 二维码编码器测试：不借任何第三方解码器，全靠「自己按规范再算一遍」对答案。
 * 三件独立的事：一是图形骨架（定位/时钟/校正/格式那几处该长什么样），
 * 二是里德-所罗门整除性（校验码字错了就除不尽），三是照格式信息里的掩码把正文读回来。
 * 校验用的 GF(256) 乘法在这儿是「俄罗斯农民」逐位累加的写法，跟编码器那张对数表不是一条路，
 * 两边都对上才算数。
 */
import { QR_MAX_BYTES, qrBlocks, qrDataCells, qrMatrix, qrVersionOf } from '../web/qr.ts';

let failures = 0;
function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

const SIZES = [21, 25, 29, 33];
const VERSION_OF: Record<number, number> = { 21: 1, 25: 2, 29: 3, 33: 4 };
/** ISO/IEC 18004 附录 D：L 档 1～4 版，每版一个块 */
const ECC_L: Record<number, { data: number; ec: number }> = {
  1: { data: 19, ec: 7 },
  2: { data: 34, ec: 10 },
  3: { data: 55, ec: 15 },
  4: { data: 80, ec: 20 },
};
/** 字节模式容量：数据码字 × 8 减掉模式 4 位和长度 8 位，剩下的整字节 */
const CAP: Record<number, number> = Object.fromEntries(
  [1, 2, 3, 4].map((v) => [v, Math.floor((ECC_L[v]!.data * 8 - 12) / 8)]),
);
/** 每个版随便挑一个装得下的长度（17 字节以下只会出 1 版，得给够才升版） */
const TEXT_OF: Record<number, string> = Object.fromEntries(SIZES.map((s) => [s, 'x'.repeat(CAP[VERSION_OF[s]!]! - 5)]));

// —— 测试自己那套 GF(256) 与多项式运算（本原多项式 x^8+x^4+x^3+x^2+1）——
function xtime(v: number): number {
  const p = v << 1;
  return (p & 0x100 ? p ^ 0x11d : p) & 0xff;
}

function gfMul(a: number, b: number): number {
  let p = 0;
  while (b) {
    if (b & 1) p ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return p;
}

/** (x-α^0)(x-α^1)…(x-α^(n-1))，高次在前；α^i 靠反复倍 2 求，不查表 */
function generator(n: number): number[] {
  let poly = [1];
  let alpha = 1;
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], alpha);
    }
    poly = next;
    alpha = xtime(alpha);
  }
  return poly;
}

/** 整条码字流按生成多项式做长除，除得尽（末 n 位全 0）才说明校验码字是对的 */
function divisible(stream: number[], n: number): boolean {
  const gen = generator(n);
  const rem = stream.slice();
  for (let i = 0; i + gen.length - 1 < rem.length; i++) {
    const lead = rem[i]!;
    if (!lead) continue;
    for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j]!, lead);
  }
  return rem.slice(rem.length - n).every((v) => v === 0);
}

/** BCH(15,5)：把 0x5412 那层亦或剥掉，10 位校验照生成式 0x537 再算一遍 */
function bchOk(bits: number): boolean {
  const raw = bits ^ 0x5412;
  const data = raw >> 10;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (raw & 0x3ff) === (rem & 0x3ff);
}

const MASK_BIT = [
  (x: number, y: number) => (x + y) % 2 === 0,
  (x: number, y: number) => y % 2 === 0,
  (x: number, y: number) => x % 3 === 0,
  (x: number, y: number) => (x + y) % 3 === 0,
  (x: number, y: number) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** 格式信息那 15 位的落点，两份各一套（位序 i → [行, 列]） */
function formatCells(size: number, which: number): number[][] {
  if (which === 0) {
    const a: number[][] = [];
    for (let i = 0; i <= 5; i++) a[i] = [i, 8];
    a[6] = [7, 8];
    a[7] = [8, 8];
    a[8] = [8, 7];
    for (let i = 9; i < 15; i++) a[i] = [8, 14 - i];
    return a;
  }
  const b: number[][] = [];
  for (let i = 0; i < 8; i++) b[i] = [8, size - 1 - i];
  for (let i = 8; i < 15; i++) b[i] = [size - 15 + i, 8];
  return b;
}

function readFormat(grid: boolean[][], size: number, which: number): number {
  let bits = 0;
  for (const i of [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
    const cell = formatCells(size, which)[i]!;
    bits = (bits << 1) | (grid[cell[0]!]![cell[1]!] ? 1 : 0);
  }
  return bits;
}

/** 掩码是从格式信息里读出来的，别硬写 */
function maskOf(grid: boolean[][], size: number): number {
  return (readFormat(grid, size, 0) ^ 0x5412) >> 10 & 7;
}

/** 按蛇形数据格＋指定掩码，把码字一位位读回来 */
function readStream(grid: boolean[][], size: number, mask: number, count: number): number[] {
  const cells = qrDataCells(size);
  const flip = MASK_BIT[mask]!;
  const out: number[] = [];
  for (let c = 0; c < count; c++) {
    let b = 0;
    for (let k = 0; k < 8; k++) {
      const cell = cells[c * 8 + k]!;
      b = (b << 1) | (grid[cell[0]!]![cell[1]!] !== flip(cell[1]!, cell[0]!) ? 1 : 0);
    }
    out.push(b);
  }
  return out;
}

/** 数据码字里那串位流是「模式 4 位＋长度 8 位＋正文」，按位拆 */
function decodeBody(data: number[]): { mode: number; bytes: Uint8Array } {
  const bits: number[] = [];
  for (const b of data) for (let k = 7; k >= 0; k--) bits.push((b >> k) & 1);
  const take = (at: number, len: number): number => {
    let v = 0;
    for (let i = 0; i < len; i++) v = (v << 1) | bits[at + i]!;
    return v;
  };
  const len = take(4, 8);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = take(12 + i * 8, 8);
  return { mode: take(0, 4), bytes };
}

console.log('二维码用例：');

{
  // 一、码字分配和选版
  ok('L 档码字分配跟规范一致', SIZES.every((s) => {
    const b = qrBlocks(s)!;
    return b.data === ECC_L[VERSION_OF[s]!]!.data && b.ec === ECC_L[VERSION_OF[s]!]!.ec;
  }));
  ok('每版的容量上界踩得准：正好装满是一版，多一字节升一版', [1, 2, 3, 4].every((v) => {
    const cap = CAP[v]!;
    const next = v === 4 ? null : (v + 1) * 4 + 17;
    return qrVersionOf(cap) === v * 4 + 17 && (v === 4 ? qrVersionOf(cap + 1) === null : qrVersionOf(cap + 1) === next);
  }));
  ok('17/18、32/33、53/54、78/79 四道坎都对', [
    qrVersionOf(17) === 21 && qrVersionOf(18) === 25,
    qrVersionOf(32) === 25 && qrVersionOf(33) === 29,
    qrVersionOf(53) === 29 && qrVersionOf(54) === 33,
    qrVersionOf(78) === 33 && qrVersionOf(79) === null,
  ].every(Boolean));
  ok('QR_MAX_BYTES 就是 4 版的容量', QR_MAX_BYTES === CAP[4]);
  ok('超上限编不出来，回 null', qrMatrix('x'.repeat(79)) === null && qrMatrix('x'.repeat(200)) === null);
  ok('空串也当 1 版编', qrVersionOf(0) === 21 && qrMatrix('')!.length === 21);
}

{
  // 二、数据格：个数对上规范的原始模块数（附录 C 的闭式），且不重不漏
  const rawModules = (v: number): number => {
    let n = (16 * v + 128) * v + 64;
    if (v >= 2) {
      const numAlign = Math.floor(v / 7) + 2;
      n -= (25 * numAlign - 10) * numAlign - 55;
    }
    return n;
  };
  ok('每版的数据格个数等于规范的原始模块数', SIZES.every((s) => qrDataCells(s).length === rawModules(VERSION_OF[s]!)),
    SIZES.map((s) => `${s}：${qrDataCells(s).length}`).join(' '));
  ok('数据格不重复、不越界、也不踩图形区', SIZES.every((s) => {
    const cells = qrDataCells(s);
    const keys = new Set(cells.map(([y, x]) => y * s + x));
    const onTiming = cells.some(([y, x]) => y === 6 || x === 6);
    const onFinder = cells.some(([y, x]) => y <= 7 && x <= 7);
    return keys.size === cells.length && cells.every(([y, x]) => y >= 0 && y < s && x >= 0 && x < s) && !onTiming && !onFinder;
  }));
  ok('多出来的那几个位不足一格（1～4 版分别余 0/7/7/7）', SIZES.every((s) => {
    const b = qrBlocks(s)!;
    const spare = qrDataCells(s).length - (b.data + b.ec) * 8;
    return spare >= 0 && spare < 8;
  }));
  ok('蛇形从右下角起，先上后下两列一切', (() => {
    const cells = qrDataCells(21);
    return cells[0]![0] === 20 && cells[0]![1] === 20 && cells[1]![0] === 20 && cells[1]![1] === 19;
  })());
}

{
  // 三、图形骨架：这几处错了手机压根对不上焦
  for (const size of SIZES) {
    const grid = qrMatrix(TEXT_OF[size]!)!;
    const tag = `${size} 格`;
    const finder = (top: number, left: number): boolean => {
      for (let y = 0; y <= 6; y++)
        for (let x = 0; x <= 6; x++) {
          const on = y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4);
          if (grid[top + y]![left + x] !== on) return false;
        }
      return true;
    };
    ok(`${tag}：三个定位图形各就各位`, finder(0, 0) && finder(0, size - 7) && finder(size - 7, 0));
    const quiet: number[][] = [];
    for (let i = 0; i <= 7; i++) quiet.push([7, i], [i, 7], [7, size - 8 + i], [i, size - 8], [size - 8, i]);
    ok(`${tag}：定位图形外的分隔带是亮的`, quiet.every(([y, x]) => grid[y]![x] === false));
    ok(`${tag}：两条时钟线一深一浅交替`, (() => {
      for (let i = 8; i < size - 8; i++) if (grid[6]![i] !== (i % 2 === 0) || grid[i]![6] !== (i % 2 === 0)) return false;
      return true;
    })());
    ok(`${tag}：永远深色那一枚在 (${size - 8}, 8)`, grid[size - 8]![8] === true);
    // 回字形的校正图形：1 版一枚没有，2～4 版一枚不多
    const alignAt = (top: number, left: number): boolean => {
      for (let y = 0; y < 5; y++)
        for (let x = 0; x < 5; x++) if (grid[top + y]![left + x] !== (Math.max(Math.abs(y - 2), Math.abs(x - 2)) !== 1)) return false;
      return true;
    };
    const found: string[] = [];
    for (let y = 0; y <= size - 5; y++) for (let x = 0; x <= size - 5; x++) if (alignAt(y, x)) found.push(`${y},${x}`);
    const want = size === 21 ? [] : [`${size - 9},${size - 9}`];
    ok(`${tag}：校正图形就该有 ${want.length} 枚，位置在离角 7 格`, found.join(' ') === want.join(' '), `找到 ${found.join(' ') || '无'}`);
    const a = readFormat(grid, size, 0);
    const b = readFormat(grid, size, 1);
    ok(`${tag}：格式信息两份一致、BCH 算得过、档位是 L、掩码在 0～7`, a === b && bchOk(a) && (a ^ 0x5412) >> 13 === 0b01 && maskOf(grid, size) < 8);
  }
}

const TEXTS = [
  'http://127.0.0.1:5199/',
  'http://192.168.31.245:5199/',
  'http://10.0.0.2:80/',
  'http://172.16.9.130:5199/',
  'http://[fe80::1c3d:2eb4:4f5a:6b7c]:5199/',
  'http://chess-dundun.local:5199/?room=7',
  'http://192.168.104.222:60000/',
  'a',
  'x'.repeat(17),
  'x'.repeat(18),
  'x'.repeat(32),
  'x'.repeat(33),
  'x'.repeat(53),
  'x'.repeat(54),
  'x'.repeat(78),
  '棋墩墩 http://192.168.1.7:5199/',
];

{
  // 四、往返：照格式信息里的掩码读回来，正文得一字不差
  for (const text of TEXTS) {
    const grid = qrMatrix(text);
    if (!grid) {
      ok(`装得下：${text.slice(0, 24)}`, false, '回了 null');
      continue;
    }
    const size = grid.length;
    const blocks = qrBlocks(size)!;
    const mask = maskOf(grid, size);
    const stream = readStream(grid, size, mask, blocks.data + blocks.ec);
    const body = stream.slice(0, blocks.data);
    const utf8 = new TextEncoder().encode(text);
    const { mode, bytes } = decodeBody(body);
    const label = `${size} 格／掩码 ${mask}｜${text.slice(0, 26)}${text.length > 26 ? '…' : ''}`;
    ok(label, mode === 4 && bytes.length === utf8.length && new TextDecoder().decode(bytes) === text,
      `模式 ${mode}、读回「${new TextDecoder().decode(bytes).slice(0, 26)}」`);
    ok(`　└ ${size}｜里德-所罗门除得尽`, divisible(stream, blocks.ec));
    const padStart = Math.ceil((12 + utf8.length * 8) / 8);
    const pads = body.slice(padStart);
    ok(`　└ ${size}｜填充从 0xec 起交替`, pads.every((b, i) => b === (i % 2 === 0 ? 0xec : 0x11)),
      pads.length ? `头一个 0x${pads[0]!.toString(16)}` : '刚好填满，没有填充字节');
    const tail: number[] = [];
    for (let k = 12 + utf8.length * 8; k < padStart * 8; k++) tail.push((body[k >> 3]! >> (7 - (k & 7))) & 1);
    ok(`　└ ${size}｜正文后面那几位终止符是全 0`, tail.every((b) => b === 0), tail.join(''));
  }
}

{
  // 五、反向咬合：掩码给错、码字被动过，RS 一除就露馅
  const text = 'http://192.168.31.245:5199/';
  const grid = qrMatrix(text)!;
  const size = grid.length;
  const blocks = qrBlocks(size)!;
  const count = blocks.data + blocks.ec;
  const right = maskOf(grid, size);
  const strays = [0, 1, 2, 3, 4, 5, 6, 7].filter((m) => m !== right && divisible(readStream(grid, size, m, count), blocks.ec));
  ok('另外七个掩码读回来的码字都过不了 RS 校验', strays.length === 0, `混过去了：${strays}`);
  ok('照对的路读是整除的（正例别是巧合）', divisible(readStream(grid, size, right, count), blocks.ec));

  const cells = qrDataCells(size);
  const damaged = grid.map((r) => r.slice());
  for (const idx of [3, 91]) {
    const [y, x] = cells[idx]!;
    damaged[y]![x] = !damaged[y]![x];
  }
  ok('翻掉两枚数据码字的头一位，RS 就除不尽', !divisible(readStream(damaged, size, right, count), blocks.ec));

  const wrongFormat = grid.map((r) => r.slice());
  const cell = formatCells(size, 0)[4]!;
  wrongFormat[cell[0]!]![cell[1]!] = !wrongFormat[cell[0]!]![cell[1]!];
  ok('格式信息动一位，BCH 校验就过不去', !bchOk(readFormat(wrongFormat, size, 0)));

  // 编码是纯函数：同一句话两次画得一模一样，换句话就不撞车
  ok('同一句话两次逐格相同', JSON.stringify(qrMatrix(text)) === JSON.stringify(qrMatrix(text)));
  ok('两句话画不出同一个码', JSON.stringify(qrMatrix(text)) !== JSON.stringify(qrMatrix(text + '1')));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条没过`);
process.exit(failures === 0 ? 0 : 1);
