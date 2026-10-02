/**
 * 存档写不下去的时候，这张桌得活下来（2026-10-02 架构体检 H4 那一档）。
 * 两层闸：atomicPut 负责「原子」（写 .tmp 再 rename，失败抹掉中转名再往上抛），
 * openRoom 里那颗 write 负责「不抛穿」（这颗跑在 300ms 合批的 timer 回调里，
 * 从 timer 抛出去就是 uncaughtException 带走全桌——对照 serve.ts「读不出来别让整个进程跟着抛」的口径），
 * 失败还闩上 saveOff（停落盘但牌照打，Ctrl-C 后接不回这一段）。
 * A 钉「write 不接住，起桌当场炸」；B 钉「atomicPut 吞异常，那句人话永远念不出来、失败没人知道」；
 * C 钉「失败不留半截中转名」；D 钉「saveOff 那道闩」（不闩上，收桌会反复试写）。
 * 闸在 net.test.ts「存档写不下去的时候」那一段：存档位建成一个目录，rename 必然砸。
 * 跑法：npm run knives -- save-write（全跑就 npm run knives；要看每刀全红几句加 --verbose）
 */
export default {
  id: 'save-write',
  title: '存档写不下去：牌局比硬盘金贵，桌不许跟着炸',
  via: 'test',
  suite: 'test:net',
  knives: [
    {
      rel: 'src/node/room.ts',
      note: 'A write 不接住：失败直接抛穿——起桌那一下还好说，跑在 300ms timer 回调里就是 uncaughtException 带走全桌',
      from:
        '  function write(): void {\n    if (saveOff) return;\n    try {\n      atomicPut(savePath, table.save());\n    } catch (e) {\n      saveOff = true;\n      if (due) {\n        clearTimeout(due);\n        due = null;\n      }\n      console.log(`存档写不下去（${(e as Error).message}），本桌继续但不落盘：Ctrl-C 后接不回这一段`);\n    }\n  }',
      to: '  function write(): void {\n    if (saveOff) return;\n    atomicPut(savePath, table.save());\n  }',
      expect: '存档写不下去，起桌不许当场炸（牌局比硬盘金贵）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'B atomicPut 把异常吞在肚子里：write 的 catch 永远不响，saveOff 不闩，用户永远不知道存档一个字没落',
      from:
        'export function atomicPut(file: string, body: string): void {\n  const tmp = `${file}.tmp`;\n  try {\n    writeFileSync(tmp, body);\n    renameSync(tmp, file);\n  } catch (e) {\n    // 写砸／换不上就把中转名抹掉再往上抛：半截字节留在目录里，下回谁看见都以为是份正经存档\n    try {\n      rmSync(tmp, { force: true });\n    } catch {\n      /* 抹不掉也算了，下次写会盖掉它 */\n    }\n    throw e;\n  }\n}',
      to: 'export function atomicPut(file: string, body: string): void {\n  const tmp = `${file}.tmp`;\n  try {\n    writeFileSync(tmp, body);\n    renameSync(tmp, file);\n  } catch {\n    /* 吞掉，谁也不告诉 */\n  }\n}',
      expect: '念得出去哪了：「存档写不下去」那句人话得出来',
    },
    {
      rel: 'src/node/room.ts',
      note: 'C 失败不抹中转名：半截字节躺在存档旁边，下回谁看见都以为是份正经存档',
      from:
        '  } catch (e) {\n    // 写砸／换不上就把中转名抹掉再往上抛：半截字节留在目录里，下回谁看见都以为是份正经存档\n    try {\n      rmSync(tmp, { force: true });\n    } catch {\n      /* 抹不掉也算了，下次写会盖掉它 */\n    }\n    throw e;\n  }',
      to: '  } catch (e) {\n    throw e;\n  }',
      expect: '失败那一下不留半截中转名（半截字节躺在目录里，下回谁看见都以为是份正经存档）',
    },
    {
      rel: 'src/node/room.ts',
      note: 'D 拆掉 saveOff 那道闩：落盘失败之后每回 close/persist 都再试一遍、再念一句，失败被当成偶发一路重试到天荒地老',
      from: '  function write(): void {\n    if (saveOff) return;',
      to: '  function write(): void {',
      expect: '停落盘真闩上了：收桌不再反复试写',
    },
  ],
};
