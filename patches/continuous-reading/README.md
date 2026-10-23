# JMComic3 连续阅读版 — 修正说明

## 上一版的 bug

上一版虽然写了「读到末页后继续滑动才加载」，但触发条件写错了：

```js
// 错误：这个条件不需要任何手势，
// 只要最后一张图滚过视口底部就成立
if (rect.bottom <= vh - 8) { loadNext(); }
```

再叠加一个 400ms 的轮询定时器，结果就是**一滑到底就自动加载下一话**，
完全不是「手动继续滑动才加载」。这正是你看到的问题。

## 本版做法：严格手势门槛

去掉了所有会自动触发加载的判断，改成必须先满足手势条件：

1. **没有任何定时器会加载下一话。** 定时器只负责刷新提示文字。
2. 判定「读到末页」改用**最后一张图的位置**（`getBoundingClientRect`），
   不再用 `scrollHeight / scrollTop` 做比较——后者在内容异步变高、
   容器变化时会抖动，是上一版误触发的根源。
3. 加载必须同时满足：
   - 手指按下时**已经读到末页**（末图已进入视口）；
   - 之后继续向上滑，累计 **≥ 90px**。
4. 手指按下时还没到末页、滑到中途才到 → 从「到达末页那一刻」重新起算，
   **不把把内容拖到底的那段位移算进去**，避免惯性误触。
5. 滚到底那一下的惯性、以及页面自动滚动，都不算手势，不会触发。

## 使用效果

- 正常往下读，什么都没发生；
- 读到本话最后一页，屏幕下方出现
  「已到最後一頁 · 繼續下滑載入下一話」；
- 此时**再滑一下**，下一话才加载并接在下面，中间有「— 第X話 —」标题；
- 可以一路读下去，连续接多话；
- 到最后一话提示「已是最後一話」，不再请求；
- 加载失败提示「載入失敗，繼續下滑可重試」。

## 验证结果

用 headless Chromium 对**从成品 APK 中提取出来的** chunk 跑了完整回归，
14 项全部通过：

```
PASS:no-load-before-end        还没读到末页时滑动，不加载
PASS:no-auto-load-at-end       滚到底后等 1.5 秒，不自动加载  ← 上一版就错在这
PASS:load-after-swipe          到底后手动继续滑，才加载 c2
PASS:decoded-own-params        新图用「该话自己的」id/scramble_id 还原
PASS:no-chain-load             加载后等 2 秒，不会连发
PASS:load-c3                   再到底+继续滑，接续 c3
PASS:stop-at-last              最后一话再滑，不再请求
PASS:last-tip                  提示「已是最後一話」
ALLPASS(14)
```

## 实现要点

- 补丁注入阅读页 chunk `2639.49223436.chunk.js`（不重新构建前端）。
- 在**模块作用域**取出 App 的 API 层引用（`getApiEndpoint` = module 2588、
  `HttpUtil.fetchGet` = module 4999、`scramble_image` = module 5412）。
  组件内 `var e,t,s;` 遮蔽了 webpack 的 require 参数 `s`，所以不能在组件里
  直接 `s(2588)`。
- 请求走 App 自己的 API 封装，Token 签名 / AES 解密与原生一致。
- 新插入的图用**该话自己的** `id` / `scramble_id` 还原（图是乱序切割的，
  用当前话参数会花屏）。
- 新内容插到 `#root` 之外的独立容器，完全避开 React 的 DOM 管理；
  插入后做 scroll anchor 补偿，画面不跳。
- 新图 id 用 `jm_flow_img_*`，避免与 React 管理的 `img_<page>` 重复。

## 打包

- 直接从原始 `repo.zip` 读条目打包：仓库 `res/` 有 9 组大小写冲突文件
  （`BM.png` / `Bm.png` 属不同密度），Windows 解压会互相覆盖。
  最终 res 条目 377 个，与原版一致。
- `resources.arsc`、`classes.dex` 必须 STORED，旧签名 `META-INF/CERT.*` 必须删除。
- 签名 v1/v2/v3 全部通过，4 字节对齐校验通过。
