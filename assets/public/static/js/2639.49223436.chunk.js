"use strict";
/* ==== JMComic3 continuous reading runtime (injected) ==== */
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

  /* ---------------- 加载下一话 ---------------- */

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

/* ==== end runtime ==== */
(self.webpackChunk_18comic_react=self.webpackChunk_18comic_react||[]).push([[2639],{2639:(e,t,s)=>{s.r(t),s.d(t,{default:()=>oe});var n=s(9379),a=s(5403),i=s(3438),o=s(7421),r=s(3817),l=s(4694),c=s(579),d=s(5043),u=s(2190),m=s(4930),h=s(9674),p=s(1051);var JMFLOW_EP=s(2588).G6,JMFLOW_HTTP=s(4999).Ay,JMFLOW_SCR=s(5412).wR;class f extends d.Component{getSnapshotBeforeUpdate(e){const t=this.props.childRef.current;if(t&&e.isPresent&&!this.props.isPresent){const e=t.offsetParent,s=e instanceof HTMLElement&&e.offsetWidth||0,n=this.props.sizeRef.current;n.height=t.offsetHeight||0,n.width=t.offsetWidth||0,n.top=t.offsetTop,n.left=t.offsetLeft,n.right=s-n.width-n.left}return null}componentDidUpdate(){}render(){return this.props.children}}function g(e){let{children:t,isPresent:s,anchorX:n}=e;const a=(0,d.useId)(),i=(0,d.useRef)(null),o=(0,d.useRef)({width:0,height:0,top:0,left:0,right:0}),{nonce:r}=(0,d.useContext)(p.Q);return(0,d.useInsertionEffect)((()=>{const{width:e,height:t,top:l,left:c,right:d}=o.current;if(s||!i.current||!e||!t)return;const u="left"===n?"left: ".concat(c):"right: ".concat(d);i.current.dataset.motionPopId=a;const m=document.createElement("style");return r&&(m.nonce=r),document.head.appendChild(m),m.sheet&&m.sheet.insertRule('\n          [data-motion-pop-id="'.concat(a,'"] {\n            position: absolute !important;\n            width: ').concat(e,"px !important;\n            height: ").concat(t,"px !important;\n            ").concat(u,"px !important;\n            top: ").concat(l,"px !important;\n          }\n        ")),()=>{document.head.removeChild(m)}}),[s]),(0,c.jsx)(f,{isPresent:s,childRef:i,sizeRef:o,children:d.cloneElement(t,{ref:i})})}const x=e=>{let{children:t,initial:s,isPresent:n,onExitComplete:a,custom:i,presenceAffectsLayout:o,mode:r,anchorX:l}=e;const u=(0,m.M)(v),p=(0,d.useId)(),f=(0,d.useCallback)((e=>{u.set(e,!0);for(const t of u.values())if(!t)return;a&&a()}),[u,a]),x=(0,d.useMemo)((()=>({id:p,initial:s,isPresent:n,custom:i,onExitComplete:f,register:e=>(u.set(e,!1),()=>u.delete(e))})),o?[Math.random(),f]:[n,f]);return(0,d.useMemo)((()=>{u.forEach(((e,t)=>u.set(t,!1)))}),[n]),d.useEffect((()=>{!n&&!u.size&&a&&a()}),[n]),"popLayout"===r&&(t=(0,c.jsx)(g,{isPresent:n,anchorX:l,children:t})),(0,c.jsx)(h.t.Provider,{value:x,children:t})};function v(){return new Map}var w=s(8917);const y=e=>e.key||"";function S(e){const t=[];return d.Children.forEach(e,(e=>{(0,d.isValidElement)(e)&&t.push(e)})),t}var j=s(293);const b=e=>{let{children:t,custom:s,initial:n=!0,onExitComplete:a,presenceAffectsLayout:i=!0,mode:o="sync",propagate:r=!1,anchorX:l="left"}=e;const[h,p]=(0,w.xQ)(r),f=(0,d.useMemo)((()=>S(t)),[t]),g=r&&!h?[]:f.map(y),v=(0,d.useRef)(!0),b=(0,d.useRef)(f),k=(0,m.M)((()=>new Map)),[A,E]=(0,d.useState)(f),[N,I]=(0,d.useState)(f);(0,j.E)((()=>{v.current=!1,b.current=f;for(let e=0;e<N.length;e++){const t=y(N[e]);g.includes(t)?k.delete(t):!0!==k.get(t)&&k.set(t,!1)}}),[N,g.length,g.join("-")]);const L=[];if(f!==A){let e=[...f];for(let t=0;t<N.length;t++){const s=N[t],n=y(s);g.includes(n)||(e.splice(t,0,s),L.push(s))}return"wait"===o&&L.length&&(e=L),I(S(e)),E(f),null}const{forceRender:C}=(0,d.useContext)(u.L);return(0,c.jsx)(c.Fragment,{children:N.map((e=>{const t=y(e),d=!(r&&!h)&&(f===N||g.includes(t));return(0,c.jsx)(x,{isPresent:d,initial:!(v.current&&!n)&&void 0,custom:s,presenceAffectsLayout:i,mode:o,onExitComplete:d?void 0:()=>{if(!k.has(t))return;k.set(t,!0);let e=!0;k.forEach((t=>{t||(e=!1)})),e&&(null===C||void 0===C||C(),I(b.current),r&&(null===p||void 0===p||p()),a&&a())},anchorX:l,children:e},t)}))})};var k=s(4117),A=s(6580),E=s(4975),N=s(5331),I=s(1100),L=s(8038),C=s(1299),_=s(8028),M=s(501),z=s(9662);const D=(0,z.A)([(0,c.jsx)("path",{d:"M17.59 18 19 16.59 14.42 12 19 7.41 17.59 6l-6 6z"},"0"),(0,c.jsx)("path",{d:"m11 18 1.41-1.41L7.83 12l4.58-4.59L11 6l-6 6z"},"1")],"KeyboardDoubleArrowLeft"),O=(0,z.A)((0,c.jsx)("path",{d:"M4 6H2v14c0 1.1.9 2 2 2h14v-2H4zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2m-1 9H9V9h10zm-4 4H9v-2h6zm4-8H9V5h10z"}),"LibraryBooks"),H=(0,z.A)((0,c.jsx)("path",{d:"M2 17h2v.5H3v1h1v.5H2v1h3v-4H2zm1-9h1V4H2v1h1zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2zm5-6v2h14V5zm0 14h14v-2H7zm0-6h14v-2H7z"}),"FormatListNumbered");var P=s(8390),T=s(2782),R=s(3752),F=s(7680),J=s(6148),V=s(5244),q=s(3344),K=s(7353),B=s(9070),W=s(7947);const X=e=>{const{readId:t,logined:s,isLoading:a,setIsVertical:i,isVertical:o,changeCurrentPage:r,scrollProgress:u,imageCount:m,handleSliderChange:h,handlePageChange:p,setDialogOpen:f,dialogOpen:g,readList:x,detailList:v,showSnackbar:w,closeNav:y}=e,{t:S}=(0,k.Bd)(),j=(0,J.j)(),{favoriteList:b}=(0,J.G)((e=>e.member)),[A,E]=(0,d.useState)(W.x),N=JSON.parse(localStorage.getItem("likedItems")||"[]"),[L,C]=(0,d.useState)((()=>new Set(JSON.parse(localStorage.getItem("addedMarks")||"[]")))),[_,z]=(0,d.useState)((()=>new Set(JSON.parse(localStorage.getItem("removedMarks")||"[]")))),X=(e,t)=>{"add"===t?(C((t=>{const s=new Set(t);return s.add(e),localStorage.setItem("addedMarks",JSON.stringify([...s])),s})),z((t=>{const s=new Set(t);return s.delete(e),localStorage.setItem("removedMarks",JSON.stringify([...s])),s}))):(z((t=>{const s=new Set(t);return s.add(e),localStorage.setItem("removedMarks",JSON.stringify([...s])),s})),C((t=>{const s=new Set(t);return s.delete(e),localStorage.setItem("addedMarks",JSON.stringify([...s])),s})))},U=async(e,t)=>{if("like"===e){if(N.includes(t))return void w(S("snack.already_rated"),"success");localStorage.setItem("likedItems",JSON.stringify([...N,t]));const e=await j((0,I.c1)({id:t})).unwrap(),{code:s,msg:n,status:a}=e.data;if(200===s){w(n,"success"!==a?"error":"success")}}if("mark"===e)if(s){(()=>{j((0,F.a9)("favoriteList"));const{folder_id:e,o:t}=A;j((0,I.an)({page:1,folder_id:e,o:t}))})(),E((0,n.A)((0,n.A)({},A),{},{aid:t}));const e=await j((0,I.df)(t)).unwrap(),{code:s,data:a}=e;if(200===s){const e="ok"!==a.status?"error":"success";w(a.msg,e)}"ok"===a.status&&("add"===a.type||"edit"===a.type||"move"===a.type?(X(t,"add"),f((0,n.A)((0,n.A)({},g),{},{folder:!0}))):"remove"===a.type&&X(t,"remove"))}else w(S("login.please_login"),"error"),f((0,n.A)((0,n.A)({},g),{},{login:!0}))};return(0,c.jsxs)(c.Fragment,{children:[(0,c.jsxs)(l.P.nav,{initial:{y:0},animate:{y:y?200:0},transition:{type:"spring",stiffness:300,damping:30},className:"fixed left-0 bottom-0 w-full bg-nbk bg-opacity-90 z-20",children:[(0,c.jsxs)("div",{className:"flex justify-around items-center",children:[(0,c.jsx)(D,{className:"".concat(r.prev?"":"opacity-0"),onClick:()=>p("prev")}),(0,c.jsx)("span",{children:u<1?1:u}),(0,c.jsx)(K.A,{sx:{width:250},children:(0,c.jsx)(B.Ay,{value:u,min:1,valueLabelFormat:e=>"".concat(e),max:m,valueLabelDisplay:"auto",onChange:h,sx:{"& .MuiSlider-thumb":{backgroundColor:"#ff6f00"},"& .MuiSlider-rail":{backgroundColor:"#bbb",opacity:"1"},"& .MuiSlider-track":{backgroundColor:"#ff6f00",border:"none"}}})}),(0,c.jsx)("span",{children:m}),(0,c.jsx)("div",{children:(0,c.jsx)(M.A,{className:"".concat(r.next?"":"opacity-0"),onClick:()=>p("next")})})]}),(0,c.jsxs)("div",{className:"flex justify-around items-center text-center pt-2 pb-4",children:[(0,c.jsxs)("div",{className:"".concat(a?"text-[#aaa]":""),onClick:()=>!a&&i(!o),children:[(0,c.jsx)(O,{className:"text-2xl"}),(0,c.jsx)("p",{children:S(o?"detail.read_horizontally":"detail.read_vertically")})]}),(0,c.jsxs)("div",{onClick:()=>f((0,n.A)((0,n.A)({},g),{},{series:!0})),children:[(0,c.jsx)(H,{className:"text-2xl"}),(0,c.jsx)("p",{children:S("detail.chapter")})]}),(0,c.jsxs)("div",{onClick:()=>f((0,n.A)((0,n.A)({},g),{},{comment:!0})),children:[(0,c.jsx)(P.A,{className:"text-2xl"}),(0,c.jsx)("p",{children:S("detail.comments")})]}),(0,c.jsxs)("div",{onClick:()=>U("mark",t),children:[x.is_favorite&&!_.has(t)||L.has(t)?(0,c.jsx)(R.A,{className:"text-og"}):(0,c.jsx)(T.A,{className:"text-2xl text-white"}),(0,c.jsx)("p",{children:S("detail.favorites")})]}),(0,c.jsxs)("div",{onClick:()=>U("like",t),children:[(0,c.jsx)(V.A,{className:"text-2xl ".concat(x.liked||N.includes(t)?"text-og":"")}),(0,c.jsx)("p",{children:S("detail.like")})]})]})]}),g.folder&&(0,c.jsx)(q.A,{folderList:b.folder_list,dialogOpen:g,setDialogOpen:f,editFolder:A,setEditFolder:E,handleEditFolder:async e=>{"del"===e&&f((0,n.A)((0,n.A)({},g),{},{alert:!0}));const{folder_id:t,folder_name:s,aid:a}=A;if(""!==t){const n=(await j((0,I.Je)({type:e,folder_id:t,folder_name:s,aid:a}))).payload,{msg:i,status:o}=n.data;"ok"===o&&w(i,"ok"!==o?"error":"success")}else w(S("comic.added_to_favorites_success"),"success");E((e=>(0,n.A)((0,n.A)({},e),W.x)))},tagsList:v.tags})]})};var U=s(1060),G=s(30),Q=s(8284),Z=s(5411),Y=s(7044),$=s(7738),ee=s(6733),te=s(3944),se=s(9011),ne=s(2325),ae=s(223),ie=s(5412);const oe=()=>{var e,t,s;const u=(0,A.Zp)(),{config:m,setConfig:h}=(0,te.H)(),{setting:p,logined:f,memberInfo:g}=m,{t:x}=(0,k.Bd)(),{snackbars:v,setSnackbars:w,showSnackbar:y}=(0,C.q)(),[S,j]=(0,d.useState)({readSource:!1,login:!1,signUp:!1,forgot:!1,newTopic:!1,folder:!1,series:!1,comment:!1}),[M,z]=(0,d.useState)(!0),[D,O]=(0,d.useState)(W.Z),H=(0,J.j)(),{detailList:P,readList:T,isLoading:R}=(0,J.G)((e=>e.detail)),F=(0,A.zy)(),V=new URLSearchParams(F.search),q=V.get("id"),K=V.get("readId"),B=V.get("episode"),oe=V.get("subEpisode"),[re,le]=(0,d.useState)([]),[ce,de]=(0,d.useState)(!1),[ue,me]=(0,d.useState)(!1),[he,pe]=(0,d.useState)({detail:!1,detailDownload:!1,readTrack:!1}),[fe,ge]=(0,d.useState)({prev:!0,next:!0}),[xe,ve]=(0,d.useState)({menus:[],episode:Number(B),subEpisode:oe,currentChapterId:K}),[we,ye]=(0,d.useState)((()=>{const e=localStorage.getItem("read");return e?JSON.parse(e):{}})),Se=(null===(e=T.images)||void 0===e?void 0:e.length)+3||1,je=(0,d.useRef)([]),[be,ke]=(0,d.useState)(1),Ae=(0,d.useRef)(null),Ee=(0,d.useRef)(null),Ne=(0,d.useRef)(!1);(0,d.useEffect)((()=>{if(a.Ii.isNativePlatform()){if(!localStorage.getItem("hasShownVolumeHint")){const e=setTimeout((()=>{y("\u53ef\u4f7f\u7528\u97f3\u91cf\u9375\uff0b\u7ffb\u9801","success"),localStorage.setItem("hasShownVolumeHint","true")}),1e3);return()=>clearTimeout(e)}}}),[]),(0,d.useEffect)((()=>{ke(1),window.scrollTo({top:0,behavior:"smooth"}),H((0,ne.Fx)("readList")),H((0,ae.Mj)()),K&&q&&H((0,N.LN)({id:K,express:m.express}))}),[K,q,m.app_img_shunt]),(0,d.useEffect)((()=>{var e;ke(1),window.scrollTo({top:0,behavior:"smooth"}),null!==(e=Ee.current)&&void 0!==e&&e.swiper&&!M&&Ee.current.swiper.slideTo(0,0)}),[M]);const Ie=e=>{e._hasBind||(e._hasBind=!0,e.addEventListener("click",(()=>me((e=>!e)))),e.addEventListener("contextmenu",(e=>e.preventDefault())))},Le=async()=>{H((0,ne.g6)({isLoading:!0}));const e=je.current,t=e.length-1,s=[be-2,be-1,be,be+1,be+2].filter((e=>e>=0&&e<=t));try{await Promise.allSettled(s.map((async t=>{const s=e[t];if(!s)return;if(!!(s.nextElementSibling instanceof HTMLCanvasElement))return;await(e=>new Promise((t=>{if(e.complete)return t();e.onload=()=>t(),e.onerror=()=>t()})))(s),await(0,ie.wR)(s,T.id,T.scramble_id,s.alt);const n=s.nextElementSibling;n instanceof HTMLCanvasElement&&(n.style.position="absolute",n.style.top="0",Ie(n)),n&&!s.src.endsWith(".gif")||(s.classList.remove("opacity-0"),s.style.opacity="1",s.dataset.noScrambleMark="noScramble",Ie(s))})))}finally{H((0,ne.g6)({isLoading:!1}))}};(0,d.useEffect)((()=>{var e,t;(null===(e=T.images)||void 0===e?void 0:e.length)>0&&(null===(t=je.current)||void 0===t?void 0:t.length)>0&&Le()}),[T,be]),(0,d.useEffect)((()=>{if(Ne.current=!1,M&&!R){let e=0,t=0,s=0,a=!1;const i=()=>{a||(window.requestAnimationFrame((()=>{const i=document.documentElement.scrollTop||document.body.scrollTop,o=document.documentElement.scrollHeight-document.documentElement.clientHeight,{images:r,total_page:l}=T,c=Math.ceil(i/o*Se);var d;if(null!==r&&void 0!==r&&r.length&&(ke(c),(null===(d=P.series)||void 0===d?void 0:d.length)>0)){const e=l+3,t=P.series[P.series.length-1],s=localStorage.getItem("dontShowExpiry");c!==e||oe!==t.sort||null!==s||Ne.current||(Ne.current=!0,pe((e=>(0,n.A)((0,n.A)({},e),{},{readTrack:!0}))))}const u=i-e;u>0?(t+=u,s=0,t>=2e3&&(je.current.forEach(((e,t)=>{const s=null===e||void 0===e?void 0:e.nextElementSibling;s instanceof HTMLCanvasElement&&t<c-10&&s.remove()})),t=0)):u<0&&(s+=Math.abs(u),t=0,s>=2e3&&(je.current.forEach(((e,t)=>{const s=null===e||void 0===e?void 0:e.nextElementSibling;s instanceof HTMLCanvasElement&&t>c+10&&s.remove()})),s=0)),e=i,a=!1})),a=!0)};return window.addEventListener("scroll",i),()=>{window.removeEventListener("scroll",i)}}}),[T,P,M]);const Ce=e=>{const t=Math.max(Se,1),{scrollHeight:s,clientHeight:n}=document.documentElement,a=s-600-n;if(a<=0)return;const i=e/t;window.scrollTo({top:i*a,behavior:"smooth"})};(0,d.useEffect)((()=>{if(R)return;let e=0;function t(t){const s=Date.now();if(s-e<150)return;e=s;const{direction:n}=t.detail||{};ke((e=>{let t=e;var s,a;("up"===n?t=Math.max(0,e-1):"down"===n&&(t=Math.min(Se-1,e+1)),M)?Ce(t):null===(s=Ee.current)||void 0===s||null===(a=s.swiper)||void 0===a||a.slideTo(t-1);return t}))}return window.addEventListener("volumeKeyPressed",t),()=>window.removeEventListener("volumeKeyPressed",t)}),[Se,M]),(0,d.useEffect)((()=>{localStorage.setItem("read",JSON.stringify(we))}),[we]);const _e=(e,t)=>{ye((s=>{const a=s[e]||[];return a.includes(t)?s:(0,n.A)((0,n.A)({},s),{},{[e]:[...a,t]})}))};(0,d.useEffect)((()=>{const e=P.series;if(!e||0===e.length)return void ge({next:!1,prev:!1});const t=e.find((e=>e.id===K));if(!t)return void ge({next:!1,prev:!1});const s=Number(t.sort),n=1===s,a=s===e.length;ge({next:!a,prev:!n})}),[K,P.series]);(0,d.useEffect)((()=>{const{series:e}=P;if((null===e||void 0===e?void 0:e.length)>0){const t=[];for(let n=0;n<e.length;n+=10)t.push(e.slice(n,n+10));const s=t.reverse().findIndex((e=>e.some((e=>e.id===K))));ve((0,n.A)((0,n.A)({},xe),{},{menus:t,episode:s}))}}),[P.series]);(0,d.useEffect)((()=>{if(1===(null===p||void 0===p?void 0:p.is_cn)){const e=[{title:x("modal.fast_track"),key:0},...p.app_shunts||[]];le(e)}else le(p.app_shunts)}),[null===p||void 0===p?void 0:p.is_cn]);const Me=()=>{"on"===m.express&&(sessionStorage.setItem("imageSource","1"),h((e=>(0,n.A)((0,n.A)({},e),{},{express:"",app_img_shunt:"1"}))))};/*__JM_FLOW_HOOK__*/(0,d.useEffect)(function(){var A=window.__JM_FLOW_API__;if(!A)return;A.setApi({getApiEndpoint:JMFLOW_EP,fetchGet:JMFLOW_HTTP.fetchGet,scramble:JMFLOW_SCR,express:(m&&m.express)||"",chapters:{series:P.series||[],readId:K,queryId:q},toggleNav:function(){try{me(function(v){return !v;});}catch(e){}},onInserted:function(payload){try{if(typeof _e==="function"&&payload&&payload.id){_e(q,payload.id);}}catch(e){}}});});;/*__JM_FLOW_HOOK2__*/(0,d.useEffect)(function(){var A=window.__JM_FLOW_API__;if(A&&A.onChapterChange){A.onChapterChange();}},[K]);;return(0,c.jsxs)(c.Fragment,{children:[R&&(0,c.jsx)(Z.A,{}),(0,c.jsxs)("div",{className:"h-full bg-white text-white relative",children:[(0,c.jsxs)(l.P.div,{initial:{y:0},animate:{y:ue?-200:0},transition:{type:"spring",stiffness:300,damping:30},className:"fixed top-[calc(env(safe-area-inset-top)+0px)] w-full bg-nbk bg-opacity-90 flex flex-col z-40",children:[(0,c.jsx)(Q.A,{}),(0,c.jsx)(b,{children:!S.comment&&(0,c.jsxs)(l.P.div,{initial:{y:0},animate:{y:S.comment?-200:0},transition:{type:"spring",stiffness:300,damping:30},className:"w-full flex justify-between items-center h-14 px-3 py-2",children:[(0,c.jsx)(se.ee,{back:"/comic/detail?id=".concat(q||P.series_id,"&readId=").concat(K,"&episode=").concat(xe.episode,"&subEpisode=").concat(xe.subEpisode)}),(0,c.jsx)("p",{className:"truncate w-10/12",children:T.name}),(0,c.jsx)(r.A,{sx:{fontSize:26,stroke:"white",strokeWidth:1},onClick:()=>de(!0)})]})})]}),(0,c.jsx)("div",{onClick:e=>e.preventDefault(),className:"pt-20 pb-40 flex items-center h-full",ref:Ae,style:{flexDirection:M?"column":"row",overflowX:M?"hidden":"scroll",overflowY:M?"scroll":"hidden",scrollSnapType:M?"y mandatory":"x mandatory"},children:M?(0,c.jsxs)(c.Fragment,{children:[null,(null===(t=T.images)||void 0===t?void 0:t.length)>0&&T.images.map(((e,t)=>{var s,n,a;return(0,c.jsx)("div",{className:"w-full relative mt-[-2px]",children:(0,c.jsx)("img",{ref:e=>je.current[t]=e,src:e.image,alt:null!==(s=null===(n=e.image)||void 0===n||null===(a=n.match(/\/([^\/]+)\.webp/))||void 0===a?void 0:a[1])&&void 0!==s?s:null,width:"100%",height:"auto",id:"img_"+e.page,className:"w-full object-cover",style:{opacity:0},loading:"lazy",draggable:!1,onContextMenu:e=>e.preventDefault(),onDragStart:e=>e.preventDefault()})},e.page)})),null]}):(0,c.jsx)(c.Fragment,{children:(0,c.jsxs)(E.RC,{initialSlide:0,className:"mySwiper h-screen",onSlideChange:e=>{const t=e.activeIndex+1;if(ke(t),Ee.current){const e=document.querySelectorAll("canvas");Ee.current.swiper.realIndex%5===0&&e.length>0&&e[0].remove()}},ref:Ee,children:[null,(null===(s=T.images)||void 0===s?void 0:s.length)>0&&T.images.map(((e,t)=>{var s,n,a;return(0,c.jsx)(E.qr,{children:(0,c.jsx)("img",{ref:e=>je.current[t]=e,src:e.image,alt:null!==(s=null===(n=e.image)||void 0===n||null===(a=n.match(/\/([^\/]+)\.webp/))||void 0===a?void 0:a[1])&&void 0!==s?s:null,width:"100%",height:"auto",loading:"lazy",id:"img_"+e.page,className:"w-full object-cover opacity-0",draggable:!1,onContextMenu:e=>e.preventDefault(),onDragStart:e=>e.preventDefault()})},e.image)})),null,null]})})}),S.series&&(0,c.jsxs)("div",{className:"w-full h-[90vh] sticky bottom-0 left-0 bg-white dark:bg-bbk z-50 overflow-y-auto transition-all duration-1000 ".concat(S.series?"animate-move-up":"animate-move-down"),children:[(0,c.jsxs)("div",{className:"h-12 sticky top-0 bg-nbk flex items-center z-20",children:[(0,c.jsx)(i.A,{sx:{fontSize:24,stroke:"white",strokeWidth:2,marginLeft:2},onClick:()=>j((0,n.A)((0,n.A)({},S),{},{series:!1}))}),(0,c.jsx)("p",{className:"ml-5 truncate w-9/12",children:T.name})]}),(0,c.jsx)("div",{className:"w-11/12 m-auto",children:(0,c.jsx)(U.A,{t:x,episodeOnTop:!0,queryId:q,detailList:P,seriesGroups:xe,setSeriesGroups:ve,msgOpen:he,handlerReadStorage:_e,readHistory:we,setDialogOpen:j,closeExpress:Me})})]}),S.comment&&(0,c.jsxs)("div",{className:"w-full h-[90vh] sticky bottom-0 left-0 bg-[#ededed] z-30 overflow-y-auto transition-all duration-1000 ".concat(S.comment?"animate-move-up":"animate-move-down"),children:[(0,c.jsxs)("div",{className:"h-12 sticky top-0 bg-nbk flex items-center z-20",children:[(0,c.jsx)(i.A,{sx:{fontSize:24,stroke:"white",strokeWidth:2,marginLeft:2},onClick:()=>j((0,n.A)((0,n.A)({},S),{},{comment:!1}))}),(0,c.jsx)("p",{className:"ml-5 truncate w-9/12",children:T.name})]}),(0,c.jsxs)("div",{className:"w-full m-auto text-gy dark:text-tgy dark:bg-bbk",children:[(0,c.jsx)("div",{className:"py-3 px-2"}),(0,c.jsx)(_.A,{t:x,bottomTopicInput:!0,queryId:q,setting:p,memberInfo:g,logined:f,dialogOpen:S,setDialogOpen:j,showSnackbar:y})]})]}),(0,c.jsx)(b,{children:!ue&&(0,c.jsx)(l.P.button,{className:"fixed left-4 bottom-40 bg-og rounded-full size-16 z-20",onClick:()=>j((0,n.A)((0,n.A)({},S),{},{readSource:!0})),initial:{opacity:0,y:20},animate:{opacity:1,y:0},exit:{opacity:0,y:20},transition:{duration:.3},whileTap:{scale:.9},whileHover:{scale:1.05},children:(0,c.jsx)(o.A,{className:"text-4xl"})})}),(0,c.jsx)(X,{readId:K,logined:f,isLoading:R,setIsVertical:z,isVertical:M,changeCurrentPage:fe,handlePageChange:e=>{Me(),ge((0,n.A)((0,n.A)({},fe),{},{next:!0,prev:!0}));const{series:t}=P;if((null===t||void 0===t?void 0:t.length)>0){const s=t.findIndex((e=>e.id===K)),a=t["next"===e?s+1:s-1];if(a){const e=xe.menus.findIndex((e=>e.some((e=>e.id===K))));ve((e=>(0,n.A)((0,n.A)({},e),{},{subEpisode:a.sort,currentChapterId:a.id}))),_e(q,a.id),u("/comic/detail/read?id=".concat(q,"&readId=").concat(a.id,"&episode=").concat(e,"&subEpisode=").concat(a.sort))}}},scrollProgress:be,imageCount:Se,handleSliderChange:(e,t)=>{const s=t;M?Ce(s):Ee.current&&(Ee.current.swiper.slideTo(t-1),ke(s))},setDialogOpen:j,dialogOpen:S,readList:T,detailList:P,showSnackbar:y,closeNav:ue})]}),S.readSource&&(0,c.jsx)(Y.A,{readImgSource:re,setDialogOpen:j,dialogOpen:S}),ce&&(0,c.jsx)(G.A,{share:ce,setShare:de,setting:p,queryId:K,showSnackbar:y}),(S.login||S.signUp||S.forgot)&&!f&&(0,c.jsx)($.A,{setFormData:O,formData:D,setConfig:h,logined:f,isLoading:R,setDialogOpen:j,dialogOpen:S,showSnackbar:y}),he.readTrack&&(0,c.jsx)(ee.A,{t:x,logined:f,queryId:q,setMsgOpen:pe,msgOpen:he,handleTracking:async e=>{if(f){const t=await H((0,I.mI)(e)).unwrap(),{code:s,data:n}=t;200===s&&y(n,"success")}else y(x("login.please_login"),"error"),j((0,n.A)((0,n.A)({},S),{},{login:!0}))},handleSetDontShow:e=>{const t=localStorage.getItem("threeDaysDontShow"),s=t?JSON.parse(t):[];if(e.target.checked){if(!s.includes(q)){s.push(q),localStorage.setItem("threeDaysDontShow",JSON.stringify(s));const e=Date.now()+2592e5;localStorage.setItem("dontShowExpiry",e.toString())}}else{const e=s.filter((e=>e!==q));localStorage.setItem("threeDaysDontShow",JSON.stringify(e)),localStorage.removeItem("dontShowExpiry")}}}),(0,c.jsx)(C.A,{setSnackbars:w,snackbars:v})]})}},7421:(e,t,s)=>{s.d(t,{A:()=>i});var n=s(9662),a=s(579);const i=(0,n.A)((0,a.jsx)("path",{d:"M7 2v11h3v9l7-12h-4l4-8z"}),"FlashOn")},501:(e,t,s)=>{s.d(t,{A:()=>i});var n=s(9662),a=s(579);const i=(0,n.A)([(0,a.jsx)("path",{d:"M6.41 6 5 7.41 9.58 12 5 16.59 6.41 18l6-6z"},"0"),(0,a.jsx)("path",{d:"m13 6-1.41 1.41L16.17 12l-4.58 4.59L13 18l6-6z"},"1")],"KeyboardDoubleArrowRight")}}]);
//# sourceMappingURL=2639.49223436.chunk.js.map