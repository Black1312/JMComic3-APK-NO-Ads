/*!
 * JMComic3 连续阅读 —— 手动读到本话最后一页后，继续滑动才加载下一话
 * ==================================================================
 * 严格语义（这次按此实现，不做任何自动触发）：
 *
 *   1. 用户手动往下读。没读到末尾时，什么都不会发生。
 *   2. 读到本话最后一页并且真的滚到底了，才显示提示
 *      「已到最後一頁 · 繼續下滑載入下一話」。
 *   3. 只有在「已经到底」之后，用户再做一次**新的滑动手势**
 *      （手指开始时就已在底部，再向上滑累计 ≥ 90px）
 *      才会加载下一话。滚到底那一下的惯性不会被算进去。
 *   4. 没有任何定时器会自动加载；定时器只用来刷新提示文字。
 *   5. 没有下一话时提示「已是最後一話」，并且不再请求。
 *
 * 只操作 DOM / 手势 / 滚动位置，不写 React 内部状态。
 */
(function () {
  if (window.__JM_FLOW__) { return; }
  window.__JM_FLOW__ = true;

  var TH = 90;          /* 到底后继续滑动多少像素才加载 */
  var MARGIN = 4;       /* 判定"到底"的容差 */

  var S = {
    api: null,
    loading: false,
    done: false,
    cursorId: null,
    flowHost: null,
    banner: null,
    retryAt: 0,
    tip: "",
    anchorTop: 0,
    anchorH: 0,
    scrollerCache: null,
    userTouched: false   /* 用户是否已经有过交互（避免开场误判） */
  };

  /* ---------------- 基础工具 ---------------- */
  function now() { return Date.now(); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  /* 提示条：固定定位、不参与文档布局。
     用一个只创建一次的宿主节点，避免反复 append 影响 scrollHeight。 */
  var bannerHost = null;

  function getBanner() {
    if (S.banner && bannerHost && document.body.contains(bannerHost)) { return S.banner; }
    if (!bannerHost || !document.body.contains(bannerHost)) {
      bannerHost = document.createElement("div");
      bannerHost.setAttribute("data-jm-flow-ui", "1");
      /* 固定定位 + 零尺寸，绝不参与布局 */
      bannerHost.style.cssText = [
        "position:fixed", "left:0", "top:0", "width:0", "height:0",
        "overflow:visible", "z-index:2147483000", "pointer-events:none"
      ].join(";");
      document.body.appendChild(bannerHost);
    }
    var d = document.createElement("div");
    d.setAttribute("data-jm-flow-banner", "1");
    d.style.cssText = [
      "position:absolute", "left:50%", "top:0", "transform:translate(-50%,0)",
      "max-width:78vw", "padding:9px 16px", "border-radius:999px",
      "background:rgba(17,17,17,.82)", "color:#fff", "font-size:13px",
      "line-height:1.4", "text-align:center", "white-space:nowrap",
      "display:none", "-webkit-user-select:none", "user-select:none",
      "box-shadow:0 2px 10px rgba(0,0,0,.35)", "pointer-events:none"
    ].join(";");
    bannerHost.appendChild(d);
    S.banner = d;
    return d;
  }

  function setTip(text, color) {
    if (S.tip === text && S.banner) { return; }
    S.tip = text;
    var b = getBanner();
    if (!text) { b.style.display = "none"; return; }
    b.textContent = text;
    b.style.color = color || "#fff";
    b.style.display = "block";
  }

  /* ---------------- 滚动容器 ---------------- */

  /* App 的阅读页就是文档级滚动（原代码读 document.documentElement.scrollTop），
     所以这里固定用文档滚动元素，不做启发式探测——探测会在容器高度变化时
     选中不同节点，导致"是否到底"的判定抖动。 */
  function scroller() {
    return document.scrollingElement || document.documentElement;
  }

  function isDoc(sc) {
    return sc === document.documentElement || sc === document.scrollingElement || sc === document.body;
  }

  function metrics() {
    var sc = scroller();
    var viewport = window.innerHeight || document.documentElement.clientHeight;
    return {
      el: sc,
      top: sc.scrollTop || window.pageYOffset || 0,
      viewport: viewport,
      total: Math.max(sc.scrollHeight, document.documentElement.scrollHeight)
    };
  }

  /* "是否读到本话最后一页"
     -------------------------------------------------------------
     不用 scrollHeight / scrollTop 判断（这些值在滚动容器变化、
     内容异步变高时容易抖动），直接看页面里最后一张图的实际位置：
     它的底边已经进入视口 = 用户已经读到本话最后一页。

     这样得到的是"看到了末页"这一事实，与"还能不能继续滚"无关；
     是否加载下一话由手势逻辑另行决定，两者互不干扰。 */
  function lastImageBottom() {
    var list = readImages();
    if (!list.length) { return null; }
    var last = list[list.length - 1];
    var r = last.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { return null; }
    return r.bottom;
  }

  /* 阅读区里所有图片：React 管理的本话图 + 我们插入的后续话图 */
  function readImages() {
    var a = document.querySelectorAll('img[id^="img_"], img[data-jm-flow-img]');
    return a;
  }

  function viewportH() {
    return window.innerHeight || document.documentElement.clientHeight;
  }

  /* 已经读到本话最后一页：末图底边进入视口 */
  function reachedLastPage() {
    var b = lastImageBottom();
    if (b === null) { return false; }
    return b <= viewportH() + 4;
  }

  /* 是否还能继续往下滚（用于区分"到底了"和"页尾还有余量"） */
  function atEnd() {
    var sc = scroller();
    var viewport = viewportH();
    var total = Math.max(sc.scrollHeight, document.documentElement.scrollHeight);
    var scrollable = total - viewport;
    if (scrollable <= MARGIN) {
      return !!S.userTouched;
    }
    return (sc.scrollTop || window.pageYOffset || 0) >= (scrollable - MARGIN);
  }

  /* ---------------- 数据 ---------------- */

  function chapters() {
    return (S.api && S.api.chapters) || null;
  }

  function nextChapter() {
    var c = chapters();
    if (!c || !c.series || !c.series.length) { return null; }
    var cur = String(S.cursorId || c.readId), i;
    for (i = 0; i < c.series.length; i++) {
      if (c.series[i] && String(c.series[i].id) === cur) { break; }
    }
    if (i < 0 || i >= c.series.length) { return null; }
    return i >= c.series.length - 1 ? null : c.series[i + 1];
  }

  function fetchChapter(id) {
    return new Promise(function (resolve, reject) {
      var api = S.api;
      if (!api || !api.fetchGet) { return reject(new Error("api 尚未就绪")); }
      var url;
      try { url = api.getApiEndpoint("API_COMIC_READ"); }
      catch (e) { return reject(e); }

      var settled = false;
      function ok(res) {
        if (settled) { return; }
        settled = true;
        if (!res || res.code !== 200 || !res.data || !res.data.images) {
          return reject(new Error("响应无效"));
        }
        resolve(res.data);
      }
      function bad(e) {
        if (settled) { return; }
        settled = true;
        reject(e instanceof Error ? e : new Error(String(e)));
      }
      try {
        api.fetchGet(url, { id: id, express: api.express || "" }, ok, bad);
      } catch (e) { bad(e); }
    });
  }

  /* ---------------- 插入位置 ---------------- */

  function flowHost() {
    if (S.flowHost && document.contains(S.flowHost)) { return S.flowHost; }

    /* 有我们自己的容器就复用 */
    var mine = document.querySelector("[data-jm-flow-host]");
    if (mine) { S.flowHost = mine; return mine; }

    var sc = scroller();
    var host;

    if (isDoc(sc)) {
      /* 文档滚动：放到 #root 之外，完全避开 React 的 DOM 管理 */
      host = document.createElement("div");
      host.setAttribute("data-jm-flow-host", "1");
      host.style.cssText = "width:100%;margin:0;padding:0;position:relative;z-index:1;";
      document.body.appendChild(host);
    } else {
      /* 内部容器滚动：只能追加到滚动容器末尾 */
      host = document.createElement("div");
      host.setAttribute("data-jm-flow-host", "1");
      host.style.cssText = "width:100%;margin:0;padding:0;";
      sc.appendChild(host);
    }

    S.flowHost = host;
    return host;
  }

  function buildHead(payload) {
    var h = document.createElement("div");
    h.setAttribute("data-jm-flow-head", "1");
    h.style.cssText = [
      "width:100%", "box-sizing:border-box", "padding:18px 14px 14px",
      "text-align:center", "font-size:13px", "letter-spacing:1px",
      "color:#9a9a9a", "background:#fafafa", "border-top:1px solid #ececec"
    ].join(";");
    h.textContent = payload.name ? ("— " + payload.name + " —") : "— 下一話 —";
    return h;
  }

  function buildImage(item) {
    var box = document.createElement("div");
    box.className = "w-full relative mt-[-2px]";
    box.setAttribute("data-jm-flow-item", "1");

    var img = document.createElement("img");
    img.src = item.image;
    var m = item.image && item.image.match(/\/([^\/]+)\.webp/);
    img.alt = m ? m[1] : (item.alt || "");
    img.id = "jm_flow_img_" + item.page;
    img.setAttribute("data-jm-flow-img", "1");
    img.setAttribute("width", "100%");
    img.setAttribute("height", "auto");
    img.className = "w-full object-cover";
    img.style.opacity = "0";
    img.draggable = false;
    img.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    img.addEventListener("dragstart", function (e) { e.preventDefault(); });

    box.appendChild(img);
    return { box: box, img: img };
  }

  /* ---------------- 切割图还原 ----------------
     App 的 scramble_image(img, aid, scramble_id, page) 是同步函数，
     会把还原结果画到 img 后面的 canvas 上。
     必须用「这一话自己的」id / scramble_id，否则会花屏。 */
  function decodeOne(img, payload) {
    if (img.dataset.jmFlowDecoded) { return; }
    img.dataset.jmFlowDecoded = "1";

    var api = S.api;
    var fallback = function () {
      img.style.opacity = "1";
      img.dataset.noScrambleMark = "noScramble";
    };

    if (!api || typeof api.scramble !== "function") { return fallback(); }

    try {
      api.scramble(img, payload.id, payload.scramble_id, img.alt);
      var cv = img.nextElementSibling;
      if (cv instanceof HTMLCanvasElement) {
        cv.style.position = "absolute";
        cv.style.top = "0";
        cv.setAttribute("data-jm-flow-canvas", "1");
        cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
        cv.addEventListener("click", function () {
          if (api.toggleNav) { try { api.toggleNav(); } catch (e) {} }
        });
      } else {
        fallback();
        img.addEventListener("click", function () {
          if (api.toggleNav) { try { api.toggleNav(); } catch (e) {} }
        });
      }
    } catch (e) { fallback(); }
  }

  function decodeAll(payload, imgs) {
    imgs.forEach(function (img) {
      if (img.complete) { decodeOne(img, payload); }
      else {
        img.addEventListener("load", function () { decodeOne(img, payload); }, { once: true });
        img.addEventListener("error", function () { img.style.opacity = "1"; }, { once: true });
      }
    });
  }

  /* ---------------- 阅读记录写入（兜底） ----------------
     不依赖组件回调：直接把新话记进 localStorage 的 read 键。
     详情页与目录都从这个键读已读进度，这样即使 React 侧
     更新被跳过，退出阅读页后看到的进度也是对的。 */
  function writeReadRecord(chapterId) {
    try {
      var c = S.api && S.api.chapters;
      var cid = c && c.queryId;
      if (!cid || !chapterId) { return; }
      var raw = localStorage.getItem("read");
      var hist = raw ? JSON.parse(raw) : {};
      if (!hist[cid] || !(hist[cid] instanceof Array)) { hist[cid] = []; }
      if (hist[cid].indexOf(chapterId) < 0) {
        hist[cid] = hist[cid].concat([chapterId]);
        localStorage.setItem("read", JSON.stringify(hist));
      }
    } catch (e) {}
  }

  /* ---------------- 同步 React 侧状态 ----------------
     连续阅读只是往 DOM 里补内容，React 仍以为 "当前话" 是 URL 里那一话。
     所以每接一话都要主动把三处信息同步过去：
       1) 标题（顶部）—— 指向正在阅读的那一话
       2) 阅读记录 readHistory —— 目录里的"已读"标记
       3) seriesGroups —— 目录里的当前话高亮 / 高亮到哪一章
     另外把进度写入 localStorage 的 read 键，详情页据此显示"继续阅读"。 */
  function syncReact(payload, nx) {
    var api = S.api;
    if (!api) { return; }

    /* 0) 兜底：先自己写一份 localStorage 记录 */
    writeReadRecord(payload.id);

    /* 1) 阅读记录：写入 localStorage + 通知组件更新 state */
    if (typeof api.saveRead === "function") {
      try { api.saveRead(payload.id); } catch (e) {}
    }

    /* 2) 目录高亮：把 subEpisode / currentChapterId / episode 指向新话 */
    if (typeof api.setGroups === "function") {
      try { api.setGroups(payload.id, nx && nx.sort); } catch (e) {}
    }

    /* 3) 标题：组件使用 readList.name，无法在不重载的情况下改 redux，
          这里改为直接更新顶部标题节点，并把详情页返回参数记好 */
    if (typeof api.setTitle === "function") {
      try { api.setTitle(payload.name); } catch (e) {}
    }
  }


  function loadNext() {
    if (S.loading || S.done) { return; }
    if (now() < S.retryAt) { return; }

    var nx = nextChapter();
    if (!nx) {
      S.done = true;
      setTip("已是最後一話");
      return;
    }

    S.loading = true;
    setTip("正在載入下一話…");

    var sc = scroller();
    S.anchorTop = sc.scrollTop;
    S.anchorH = sc.scrollHeight;

    fetchChapter(nx.id).then(function (payload) {
      var host = flowHost();
      var frag = document.createDocumentFragment();
      frag.appendChild(buildHead(payload));

      var imgs = [];
      (payload.images || []).forEach(function (it) {
        if (!it || !it.image) { return; }
        var made = buildImage(it);
        imgs.push(made.img);
        frag.appendChild(made.box);
      });

      host.appendChild(frag);

      /* 位置补偿：内容变高多少就补多少，阅读位置不跳 */
      var grew = sc.scrollHeight - S.anchorH;
      if (grew > 0) { sc.scrollTop = S.anchorTop + grew; }

      S.cursorId = payload.id;
      S.loading = false;
      setTip("");

      decodeAll(payload, imgs);
      syncReact(payload, nx);

      if (S.api && typeof S.api.onInserted === "function") {
        try { S.api.onInserted(payload); } catch (e) {}
      }
    }).catch(function (err) {
      S.loading = false;
      S.retryAt = now() + 2500;
      setTip("載入失敗，繼續下滑可重試", "#ffb4b4");
      console.warn("[JMFlow] 載入下一話失敗:", err);
    });
  }

  /* ---------------- 手势：读到末页后继续滑动才加载 ----------------
     语义（严格，不自动）：
       · 手指按下时如果已经读到末页（末图进入视口）→ 本次手势有资格；
       · 按下时还没到末页、滑动过程中到了 → 从"到达末页那一刻"开始计，
         之前把内容拖到底的位移不计入（避免惯性误触）；
       · 有资格后，继续向上滑累计 ≥ TH 像素才真正加载。 */
  var g = { armed: false, acc: 0, lastY: 0 };

  function startGesture(y) {
    g.armed = reachedLastPage() && !S.loading && !S.done;
    g.acc = 0;
    g.lastY = y;
  }

  function moveGesture(y) {
    var d = g.lastY - y;      /* 手指向上滑 = 继续往下读 */
    g.lastY = y;

    if (!g.armed) {
      if (d > 0 && reachedLastPage() && !S.loading && !S.done) {
        g.armed = true;
        g.acc = 0;
      }
      return;
    }

    if (d <= 0) { return; }
    g.acc += d;
    if (g.acc >= TH) {
      g.armed = false;
      g.acc = 0;
      loadNext();
    }
  }

  function onTouchStart(e) {
    var t = e.touches && e.touches[0];
    if (!t) { return; }
    S.userTouched = true;
    startGesture(t.clientY);
  }
  function onTouchMove(e) {
    var t = e.touches && e.touches[0];
    if (!t) { return; }
    moveGesture(t.clientY);
  }

  /* 桌面/鼠标滚轮：读到末页后继续向下滚才加载 */
  var wheelAcc = 0, lastWheelAt = 0;
  function onWheel(e) {
    if (!e.deltaY || e.deltaY <= 0) { return; }
    if (!reachedLastPage()) { wheelAcc = 0; return; }
    if (S.loading || S.done) { return; }
    if (now() - lastWheelAt > 500) { wheelAcc = 0; }   /* 停顿后重新计数 */
    lastWheelAt = now();
    wheelAcc += e.deltaY;
    if (wheelAcc >= TH) {
      wheelAcc = 0;
      loadNext();
    }
  }

  document.addEventListener("touchstart", onTouchStart, { passive: true });
  document.addEventListener("touchmove", onTouchMove, { passive: true });
  document.addEventListener("wheel", onWheel, { passive: true });

  /* 提示文字刷新（只改文字，绝不触发加载） */
  var lastTipCheck = 0;
  function tick() {
    var t = now();
    if (t - lastTipCheck < 250) { return; }
    lastTipCheck = t;

    if (S.loading || S.done) { return; }
    if (!reachedLastPage()) {
      if (S.tip) { setTip(""); }
      return;
    }
    setTip("已到最後一頁 · 繼續下滑載入下一話");
  }
  setInterval(tick, 250);

  /* ---------------- 对外接口 ---------------- */

  window.__JM_FLOW_API__ = {
    setApi: function (o) {
      S.api = o || null;
      S.flowHost = null;
      setTip("");
    },
    /* 供组件读回当前漫画 id（写入 read 记录时用） */
    get queryId() {
      var c = S.api && S.api.chapters;
      return (c && c.queryId) || "";
    },
    onChapterChange: function () {
      S.loading = false;
      S.done = false;
      S.cursorId = null;
      S.retryAt = 0;
      S.anchorTop = 0;
      S.anchorH = 0;
      S.userTouched = false;
      g.armed = false;
      g.acc = 0;
      wheelAcc = 0;
      setTip("");
      var old = document.querySelector("[data-jm-flow-host]");
      if (old && old.parentNode) { old.parentNode.removeChild(old); }
      S.flowHost = null;
    },
    loadNext: function () { loadNext(); },
    get state() { return S; }
  };
})();
