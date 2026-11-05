# MP3f 交付说明：调度器面板拦住「自己审自己」

分支 `dev/MP3f`（基于 main）。

## 已实现（源码 < 300 行）

- `packages/core/src/cockpit/relayModels.ts`：
  - `setRelayModel` 保存三个角色任一改动时按规格第 11 条比：
    - 开发的值取「 / 」后面的模型名（magpie 的模型 id 自带斜杠，按「 / 」切）；
    - 审查与开发模型名相同（不分大小写）→ 拒绝，提示「审查和开发都是 xxx，换一个（关卡不能自己审自己）」；
    - 整合选 opus / sonnet / haiku 时，开发模型名同时含 `claude` 和这个词 → 拒绝；整合选 magpie 的模型按模型名相等比；
    - 两边任一边是「默认」/「跟 Codex 自己的设置」/ 分组（`group/` 开头）→ 不拦；
    - 改开发时反过来也拦跟现有审查 / 整合撞。
  - `readRelayModels` 的开发那一行：值模型是分组时 `note` 加「分组里有哪些模型 IXAEON 不知道，留意别跟审查、整合重了」。
- 条件 18（面板拿掉「替补审查」「替补整合方」两行）：**没做，被冲突挡住**，见下。

## 自动化通过

```
$ node scripts/acceptance.mjs run MP3f
Test Files  1 failed | 1 passed (2)
Tests  6 passed | 1 failed (7)
```

- `mp3f-rules.test.ts`（条件 16、17）**6/6 过**；
- `mp3f-panel.test.ts`（条件 18）红。

## 冲突：条件 18 与 main 上锁定的两份测试互相矛盾（请整合方定）

- MP3f 条件 18 要求面板不再显示「替补审查」「替补整合方」两行；
- 但 main 上**已锁定**的 `apps/desktop/test/acceptance/k10a-cockpit-models.test.ts`（条件 7）明确要求 5 个角色行都在、`relay-model-current-reviewerSubstitute` 文本是「没配」；`apps/desktop/test/acceptance/mg2-panel.test.ts` 的夹具也含这两行。两份都在 `docs/委派/锁定验收.json` 里（已核对）。
- 按「不改已锁定的测试、觉得冲突就停下写交付说明」的规矩，我没有把这两行从面板拿掉——拿掉就会让 k10a / mg2 变红。
- 需要整合方二选一：① 先把 k10a-cockpit-models（条件 7）与 mg2-panel 里「替补两行」的断言按 MP3f 改掉并重锁；或 ② 改条件 18 的口径（例如「配置里保留、面板可折叠」）。改完我再补最后这一条，`mp3f-panel.test.ts` 即可转绿。

## 真机检查

未跑：条件 18 未落地，面板行为还没定，跑了也说明不了什么；其余拦截面（16、17）已由 6 条自动化覆盖（合成 relay 目录、`DSH_HOME` 指临时目录，不碰真实配置）。

## 其余三单

MP3c / MP3d / MP3e 尚未开始：先做 MP3f 时撞上上面这个锁定测试冲突，按规矩停下等你定，没有继续往下写。

## 四项

- 已实现：MP3f 第 11 条（16、17）与开发分组提醒；第 12 条（18）阻塞。
- 自动化通过：mp3f-rules 6/6；mp3f-panel 红（冲突）。
- 真机通过：未跑。
- 用户接受：未接受。
