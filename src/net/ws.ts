import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/** 一条握手完的连接 */
export interface Conn {
  readonly id: number;
  readonly addr: string;
  send(text: string): void;
  close(reason?: string): void;
}

export interface ConnHandlers {
  onOpen?(c: Conn): void;
  onMessage?(c: Conn, text: string): void;
  onClose?(c: Conn): void;
}

/** 一条消息最多这么多字节：整桌状态也就几 KB，超了不是正常玩家 */
const MAX_MESSAGE = 1 << 20;
/** 服务端探活间隔与容忍次数；手机端页面被冻结后就靠这两下判掉线。
 *  15 秒判死是「路由器抖了一下」和「这人真走了」之间来回横跳的分界，别再往长了放 */
const PING_MS = 5_000;
const PING_MISS = 3;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const FIN = 0x80;
const OP = { cont: 0x00, text: 0x01, close: 0x08, ping: 0x09, pong: 0x0a } as const;

function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** 把 `scheme://host:port/path` 削成 `host:port`：浏览器不把默认端口写进 Origin，比的时候两头都得摊平 */
function hostPart(v: string): string {
  let s = v;
  const at = s.indexOf('//');
  if (at >= 0) s = s.slice(at + 2);
  return (s.split('/')[0] ?? '').toLowerCase().replace(/:(80|443)$/, '');
}

/** 服务端 → 客户端的帧：不掩码，长度三档各写各的 */
function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  let head: number[];
  if (n < 126) head = [FIN | opcode, n];
  else if (n < 65536) head = [FIN | opcode, 126, (n >> 8) & 0xff, n & 0xff];
  else {
    // 八字节长度栏：高 32 位 + 低 32 位，一个字节都不能省
    const hi = Math.floor(n / 0x100000000);
    const lo = n >>> 0;
    head = [
      FIN | opcode,
      127,
      (hi >>> 24) & 0xff,
      (hi >>> 16) & 0xff,
      (hi >>> 8) & 0xff,
      hi & 0xff,
      (lo >>> 24) & 0xff,
      (lo >>> 16) & 0xff,
      (lo >>> 8) & 0xff,
      lo & 0xff,
    ];
  }
  return Buffer.concat([Buffer.from(head), payload]);
}

/** 攒够一帧解一帧，半包接着等。解出来的都是已经去掩码的载荷 */
class Reader {
  private chunks: Buffer[] = [];
  private size = 0;
  /** 分片消息拼在这儿；bytes 是已经拼了多少——单帧有上限，拼起来可没人管过 */
  private frag: { opcode: number; parts: Buffer[]; bytes: number } | null = null;
  /** 一旦认定这条帧不对就关死：对端已经不可信了，攒着的字节别再接着解 */
  private dead = false;
  private readonly onMsg: (opcode: number, payload: Buffer) => void;
  private readonly fail: (reason: string) => void;

  constructor(onMsg: (opcode: number, payload: Buffer) => void, fail: (reason: string) => void) {
    this.onMsg = onMsg;
    this.fail = fail;
  }

  push(chunk: Buffer): void {
    if (this.dead) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
    for (;;) {
      const step = this.take();
      if (!step) return;
      if (step === 'stop') return;
    }
  }

  /** 判这条连接说话不对：清空手上的一切，只说一次，剩下的字节一个都不再解 */
  private bail(why: string): 'stop' {
    if (!this.dead) {
      this.dead = true;
      this.chunks = [];
      this.size = 0;
      this.frag = null;
      this.fail(why);
    }
    return 'stop';
  }

  private take(): boolean | 'stop' | null {
    if (this.dead) return 'stop';
    const first = this.peek(2);
    if (!first) return null;
    const fin = (first[0] & 0x80) !== 0;
    const opcode = first[0] & 0x0f;
    if ((first[1] & 0x80) === 0) {
      // 客户端帧必须掩码：协议硬规定，也是防请求走私的一道闸
      return this.bail('客户端帧必须掩码');
    }
    let len = first[1] & 0x7f;
    let extra = 0;
    if (len === 126) extra = 2;
    else if (len === 127) extra = 8;
    const hdr = 2 + extra + 4; // 固定 2 字节 + 扩展长度 + 4 字节掩码
    const pre = this.peek(hdr);
    if (!pre) return null;
    // 扩展长度读出来才算得出一帧到底多长：拿 126/127 这个标记值当长度，整帧就切歪了
    if (extra === 2) len = pre.readUInt16BE(2);
    else if (extra === 8) {
      if (pre.readUInt32BE(2) !== 0) return this.bail('消息太大');
      len = pre.readUInt32BE(6);
    }
    const want = hdr + len;
    if (want > MAX_MESSAGE) return this.bail('消息太大');
    const all = this.peek(want);
    if (!all) return null;
    const mask = all.subarray(2 + extra, hdr);
    const payload = Buffer.from(all.subarray(hdr, want));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    this.eat(want);
    return this.consume(fin, opcode, payload) === 'stop' ? 'stop' : true;
  }

  private consume(fin: boolean, opcode: number, payload: Buffer): void | 'stop' {
    if (opcode === OP.close || opcode === OP.ping || opcode === OP.pong) {
      this.onMsg(opcode, payload);
      return;
    }
    if (opcode !== OP.cont && this.frag) {
      // 上一段还没完就另起一帧：那摊拼好的字节得一起扔掉，不能留着让人白喂
      return this.bail('上一段分片还没完');
    }
    const frag = this.frag ?? { opcode, parts: [], bytes: 0 };
    frag.bytes += payload.length;
    if (frag.bytes > MAX_MESSAGE) return this.bail('分片拼起来也超限');
    frag.parts.push(payload);
    this.frag = frag;
    if (!fin) return;
    const { opcode: first, parts } = this.frag;
    this.frag = null;
    if (first !== OP.text) return this.bail('只认文本帧');
    this.onMsg(OP.text, Buffer.concat(parts));
  }

  private peek(n: number): Buffer | null {
    if (this.size < n) return null;
    return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
  }

  private eat(n: number): void {
    this.chunks = [Buffer.concat(this.chunks).subarray(n)];
    this.size = this.chunks[0].length;
  }
}

/**
 * 一个极简 WebSocket 服务端：只认文本帧，客户端必须掩码，分片自己拼，
 * Origin 不是这桌自己的页面不握手，ping/pong 照回，5 秒一探活、连着三次没动静就掐。
 * 为零依赖手写这一截的代价：不支持扩展、不支持流式压缩、载荷上限 1 MB。
 */
export class WsServer {
  private conns = new Map<Socket, Conn>();
  private missed = new Map<Socket, number>();
  private nextId = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers: ConnHandlers;

  constructor(handlers: ConnHandlers = {}) {
    this.handlers = handlers;
  }

  /** 挂到 http server 的 upgrade 事件上；不像 WebSocket 的请求一律掐掉 */
  /** node 的 upgrade 回调把这条流报成 Duplex；交接完它实际就是 net.Socket */
  handle(req: IncomingMessage, stream: Duplex, head: Buffer): void {
    const socket = stream as Socket;
    const key = req.headers['sec-websocket-key'];
    if (!/^websocket$/i.test(req.headers.upgrade ?? '') || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    // 浏览器开 WebSocket 一定带 Origin：不是这一桌自己的页面就握手不成，
    // 否则别人家的站点能让访问者的浏览器悄悄坐上我们的牌桌。命令行客户端和测试不带这头，空着当自己人放
    const origin = req.headers.origin;
    if (origin !== undefined && hostPart(origin) !== hostPart(req.headers.host ?? '')) {
      // end() 而不是 destroy()：先话说完再挂电话，不然这行 403 可能压根没发出去
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const addr = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
    const conn: Conn = {
      id: this.nextId++,
      addr,
      send: (text) => {
        if (socket.writable) socket.write(frame(OP.text, Buffer.from(text, 'utf8')));
      },
      close: (reason) => {
        if (socket.writable) {
          socket.write(frame(OP.close, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from(reason ?? '收杆', 'utf8')])));
        }
        socket.end();
      },
    };
    const drop = () => {
      if (!this.conns.delete(socket)) return;
      this.missed.delete(socket);
      socket.destroy();
      this.handlers.onClose?.(conn);
    };
    const reader = new Reader(
      (opcode, payload) => {
        this.missed.set(socket, 0);
        if (opcode === OP.ping) socket.write(frame(OP.pong, payload));
        else if (opcode === OP.close) drop();
        else if (opcode === OP.text) this.handlers.onMessage?.(conn, payload.toString('utf8'));
      },
      (why) => {
        conn.close(why);
        socket.destroy();
      },
    );
    this.conns.set(socket, conn);
    this.missed.set(socket, 0);
    if (head.length) reader.push(head);
    socket.on('data', (b: Buffer) => reader.push(b));
    socket.once('error', drop);
    // 升级之后的 socket 是半开语义：对端只发 FIN 不会自己关，不接 end 就得等心跳才发现人走了
    socket.once('end', drop);
    socket.once('close', drop);
    this.handlers.onOpen?.(conn);
  }

  /** 探活：三个周期没收到任何帧（含 pong）就断 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [socket, n] of [...this.missed]) {
        if (n >= PING_MISS) {
          socket.destroy();
          continue;
        }
        this.missed.set(socket, n + 1);
        if (socket.writable) socket.write(frame(OP.ping, Buffer.alloc(0)));
      }
    }, PING_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const conn of [...this.conns.values()]) conn.close();
  }
}
