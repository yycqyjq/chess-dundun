/**
 * 零依赖的二维码编码器。只做「字节模式 + 纠错 L + 1～4 版」这一小块：
 * 这一块够装下任何 http://IP:端口 的地址，也够把 ISO/IEC 18004 里最易写错的几处
 * （GF(256) 里德-所罗门、BCH 格式信息、八种掩码挑罚分最小的）一次写对。
 * 5 版往上码字要分块交织、7 版往上还要多刻一段版本信息，都没做——
 * 装不下就返回 null，界面退回只显文字。
 */

/** 每版：边长、数据码字个数、纠错码字个数、校正图形中心坐标（1 版没有） */
const VERSIONS = [
  { size: 21, data: 19, ec: 7, align: [] as number[] },
  { size: 25, data: 34, ec: 10, align: [18] },
  { size: 29, data: 55, ec: 15, align: [22] },
  { size: 33, data: 80, ec: 20, align: [26] },
];

/** 字节模式的可容纳上限，留给界面先判一眼 */
export const QR_MAX_BYTES = 78;

// GF(256)，本原多项式 0x11d
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** (x-α^0)(x-α^1)…(x-α^(n-1))，高次在前 */
function generator(n: number): Uint8Array {
  let poly = Uint8Array.of(1);
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 数据码字后面那几个校验码字 */
function rsCheck(data: Uint8Array, n: number): Uint8Array {
  const gen = generator(n);
  const rem = new Uint8Array(n);
  for (const byte of data) {
    const lead = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[n - 1] = 0;
    for (let i = 0; i < n; i++) rem[i] ^= mul(gen[i + 1], lead);
  }
  return rem;
}

function pickVersion(byteLen: number): { ver: number; info: (typeof VERSIONS)[number] } | null {
  for (let i = 0; i < VERSIONS.length; i++) {
    // 4 位模式 + 8 位长度，剩下的整字节才是容量
    if (Math.floor((VERSIONS[i].data * 8 - 12) / 8) >= byteLen) return { ver: i + 1, info: VERSIONS[i] };
  }
  return null;
}

/** 模式 0100、8 位长度、正文、终止符，再交替填 0xec/0x11 填到码字个数 */
function codewords(text: string, info: { data: number }): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const out = new Uint8Array(info.data);
  const cap = out.length * 8;
  let bit = 0;
  const put = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--, bit++) if ((value >> i) & 1) out[bit >> 3] |= 1 << (7 - (bit & 7));
  };
  put(4, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  bit = Math.min(cap, bit + 4); // 终止符：最多四个 0，剩下的位置本来就是 0
  bit = Math.min(cap, Math.ceil(bit / 8) * 8);
  for (let i = bit >> 3, pad = 0xec; i < out.length; i++, pad = pad === 0xec ? 0x11 : 0xec) out[i] = pad;
  return out;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** 15 位格式信息：5 位（纠错档＋掩码）套 BCH(15,5)，再整串亦或 0x5412 */
function formatBits(level: number, mask: number): number {
  const data = (level << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 纠错 L 档在格式信息里的那两位 */
const LEVEL_L = 1;

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

/**
 * 罚分照 ISO 那四条来，写法逐条对着 nayuki 那份参照实现——尤其规则三：
 * 行首行尾各要当成垫了一段留白，不然边界上的 1:1:3:1:1 算不全，掩码会挑歪。
 */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let score = 0;
  const addRun = (len: number, hist: number[]): void => {
    if (hist[0] === 0) len += size; // 补上的那段留白
    hist.pop();
    hist.unshift(len);
  };
  // 连着七段跑长里找 1:1:3:1:1 那副骨架，两头还得垫够留白才算一处
  const core = (hist: number[]): number => {
    const n = hist[1];
    const shaped = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
    return (shaped && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0) + (shaped && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
  };
  const sweep = (at: (i: number, j: number) => boolean): void => {
    for (let i = 0; i < size; i++) {
      let color = false;
      let run = 0;
      const hist = [0, 0, 0, 0, 0, 0, 0];
      for (let j = 0; j < size; j++) {
        const c = at(i, j);
        if (c === color) {
          run++;
          if (run === 5) score += N1;
          else if (run > 5) score++;
        } else {
          addRun(run, hist);
          if (!color) score += core(hist) * N3;
          color = c;
          run = 1;
        }
      }
      if (color) {
        addRun(run, hist);
        run = 0;
      }
      addRun(run + size, hist);
      score += core(hist) * N3;
    }
  };
  sweep((i, j) => grid[i][j]!);
  sweep((j, i) => grid[i][j]!);
  // 规则二：2×2 同色一块，一块三分
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = grid[y][x];
      if (c === grid[y][x + 1] && c === grid[y + 1][x] && c === grid[y + 1][x + 1]) score += N2;
    }
  // 规则四：深浅两色差得越远越难扫
  const dark = grid.reduce((s, r) => s + r.filter(Boolean).length, 0);
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * N4;
  return score;
}

/** 这个字节数该用哪一版；超出 4 版装不下 */
export function qrVersionOf(byteLen: number): number | null {
  const chosen = pickVersion(byteLen);
  return chosen ? chosen.info.size : null;
}

/** 这一版怎么分码字：数据几个、纠错几个。反解和验证脚本都照这一个认 */
export function qrBlocks(size: number): { data: number; ec: number } | null {
  const hit = VERSIONS.find((v) => v.size === size);
  return hit ? { data: hit.data, ec: hit.ec } : null;
}

/** 一版里所有图形格（定位图形、时钟、校正图形、格式信息）之外的格，按码字位的先后排 */
function functionMap(size: number, align: number[]): boolean[][] {
  const fixed: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const mark = (y: number, x: number) => {
    if (y >= 0 && y < size && x >= 0 && x < size) fixed[y][x] = true;
  };
  // 三个定位图形连外面一圈分隔带
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ])
    for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) mark(top + y, left + x);
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  for (const cy of align) for (const cx of align) {
    if (cy < 9 && cx < 9) continue; // 压在左上定位图形上的那枚不算
    for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) mark(cy + y, cx + x);
  }
  // 格式信息那两份 15 格，加上永远深色那一枚
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(8, size - 1 - i);
    mark(size - 1 - i, 8);
  }
  mark(size - 8, 8);
  return fixed;
}

/** 数据格的下标，顺序就是码字位从上到下的落点：[y, x] 两两一组 */
export function qrDataCells(size: number): number[][] {
  const info = VERSIONS.find((v) => v.size === size);
  const fixed = functionMap(size, info ? info.align : []);
  const cells: number[][] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x]) cells.push([y, x]);
      }
  }
  return cells;
}

/** 正文编成底层那串码字（数据＋纠错） */
function streamOf(text: string, info: { data: number; ec: number }): Uint8Array {
  const body = codewords(text, info);
  const stream = new Uint8Array(info.data + info.ec);
  stream.set(body);
  stream.set(rsCheck(body, info.ec), info.data);
  return stream;
}

/**
 * 编一个码，返回边长 × 边长的深色矩阵；太长的字符串返回 null。
 * 坐标就是 [行][列]，没有留白边——留白由画它的那层加。
 */
export function qrMatrix(text: string): boolean[][] | null {
  const chosen = pickVersion(new TextEncoder().encode(text).length);
  if (!chosen) return null;
  const { size, align } = chosen.info;
  const stream = streamOf(text, chosen.info);
  const fixed = functionMap(size, align);

  const grid: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  // 三个定位图形
  const finder = (top: number, left: number) => {
    for (let y = 0; y <= 6; y++)
      for (let x = 0; x <= 6; x++) {
        const d =
          y === 0 || y === 6 || x === 0 || x === 6 ? true : y >= 2 && y <= 4 && x >= 2 && x <= 4;
        grid[top + y][left + x] = d;
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }
  for (const cy of align)
    for (const cx of align) {
      if (cy < 9 && cx < 9) continue; // 压在定位图形上的那枚不算
      for (let y = -2; y <= 2; y++)
        for (let x = -2; x <= 2; x++) grid[cy + y][cx + x] = Math.max(Math.abs(y), Math.abs(x)) !== 1;
    }

  // 数据沿着两列一格的蛇形往上填，跳过第 6 列那根时钟线；
  // 数据格比码字多出来的那几个位（1～4 版分别是 0、7、7、0）不用填，本来就是亮的
  const cells = qrDataCells(size);
  let at = 0;
  for (const [y, x] of cells) {
    if (at >= stream.length * 8) break; // 余数格留亮
    grid[y!]![x!] = ((stream[at >> 3]! >> (7 - (at & 7))) & 1) === 1;
    at++;
  }

  // 八个掩码各试一遍挑罚分最小的。掩码是亦或，再亦或一次就退回没掩的样子，
  // 犯不上每试一个掩码就整份拷贝一遍
  const flip = (mask: number): void => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) if (!fixed[y][x] && maskBit(mask, x, y)) grid[y][x] = !grid[y][x];
  };
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    flip(mask);
    drawFormat(grid, size, formatBits(LEVEL_L, mask));
    const s = penalty(grid);
    flip(mask);
    if (s < bestScore) {
      bestScore = s;
      best = mask;
    }
  }
  flip(best);
  drawFormat(grid, size, formatBits(LEVEL_L, best));
  return grid;
}

/** 把 15 位格式信息抄到左上和「左下＋右上」两份上，顺手点上那枚永远深色的格 */
function drawFormat(grid: boolean[][], size: number, bits: number): void {
  const bit = (i: number) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) grid[i][8] = bit(i);
  grid[7][8] = bit(6);
  grid[8][8] = bit(7);
  grid[8][7] = bit(8);
  for (let i = 9; i < 15; i++) grid[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) grid[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) grid[size - 15 + i][8] = bit(i);
  grid[size - 8][8] = true; // 永远深色那一枚，紧贴左下角那半串格式信息
}
