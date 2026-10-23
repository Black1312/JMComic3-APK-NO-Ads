/* eslint-disable */
/**
 * JMComic3 连续阅读补丁（严格手势版 + 状态同步）
 *
 * 用法: node patch4.js <chunkFile> <runtimeFile>
 *
 * E0 模块作用域取出 App API 层引用
 *    （组件内有 `var e,t,s;` 遮蔽了 webpack require 的 s）
 * E1 顶部内联 flow-runtime.js
 * E2 阅读组件 render 前插入 useEffect：注入 API 层 + 章节信息 + 状态同步回调
 * E3 章节切换时重置
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

function fail(m) { console.error("[PATCH][FAIL] " + m); process.exit(1); }

function replaceOnce(src, needle, repl, label) {
  const i = src.indexOf(needle);
  if (i < 0) fail(label + ": 找不到锚点");
  if (src.indexOf(needle, i + 1) >= 0) fail(label + ": 锚点不唯一");
  return src.slice(0, i) + repl + src.slice(i + needle.length);
}

const chunkFile = process.argv[2];
const runtimeFile = process.argv[3];
if (!chunkFile || !runtimeFile) fail("用法: node patch4.js <chunkFile> <runtimeFile>");

let src = fs.readFileSync(chunkFile, "utf8");
const runtime = fs.readFileSync(runtimeFile, "utf8");

console.log("[PATCH] chunk   = " + path.basename(chunkFile) + " (" + src.length + " chars)");
console.log("[PATCH] runtime = " + path.basename(runtimeFile) + " (" + runtime.length + " chars)");

if (src.indexOf("__JM_FLOW_HOOK__") >= 0) fail("该 chunk 已打过补丁");
if (src.indexOf("__JM_CN_HOOK__") >= 0) fail("检测到旧补丁(CN)，请用干净 chunk");
if (src.indexOf("__JM_AF_HOOK__") >= 0) fail("检测到旧补丁(AF)，请用干净 chunk");

const HEAD = '"use strict";';
if (src.slice(0, 4096).indexOf(HEAD) < 0) fail("E1: 找不到 \"use strict\"");

/* ---------- E0: 模块作用域取 App API 层 ---------- */
const MOD_ANCHOR = 'p=s(1051);';
const MOD_ADD = 'p=s(1051);var JMFLOW_EP=s(2588).G6,JMFLOW_HTTP=s(4999).Ay,JMFLOW_SCR=s(5412).wR;';
src = replaceOnce(src, MOD_ANCHOR, MOD_ADD, "E0");

/* ---------- E2/E3: 组件钩子 ---------- */
const ANCHOR = ';return(0,c.jsxs)(c.Fragment,{children:[R&&(0,c.jsx)(Z.A,{})';
if (src.indexOf(ANCHOR) < 0) fail("E2: 找不到阅读组件 return 锚点");

/*
 * 组件内可用变量（已核对压缩名）:
 *   q=queryId  K=readId  P=detailList  T=readList  R=isLoading
 *   S=dialogOpen  ue=closeNav  me=setCloseNav  m=config
 *   xe=seriesGroups  ve=setSeriesGroups
 *   we=readHistory   ye=setReadHistory
 *   _e=handlerReadStorage(comicId, chapterId)
 */
const HOOK = [
  ";/*__JM_FLOW_HOOK__*/",
  "(0,d.useEffect)(function(){",
  "var A=window.__JM_FLOW_API__;",
  "if(!A)return;",

  /* 顶部标题节点：取第一个可用的标题 p（header 区域内） */
  "var pickTitle=function(){",
  "var ps=document.querySelectorAll('p.truncate');",
  "for(var i=0;i<ps.length;i++){",
  "if(ps[i].className.indexOf('w-10/12')>=0){return ps[i];}",
  "}",
  "return ps.length?ps[0]:null;",
  "};",

  "A.setApi({",
  "getApiEndpoint:JMFLOW_EP,",
  "fetchGet:JMFLOW_HTTP.fetchGet,",
  "scramble:JMFLOW_SCR,",
  "express:(m&&m.express)||\"\",",
  "chapters:{series:P.series||[],readId:K,queryId:q},",
  "toggleNav:function(){try{me(function(v){return !v;});}catch(e){}},",

  /* 1) 阅读记录：写 localStorage + 更新组件 state，目录"已读"标记随之刷新
        直接写 localStorage，保证即使组件 state 更新被跳过，
        详情页/目录读到的 read 键也是最新的。 */
  "saveRead:function(chapterId){",
  "try{",
  "var raw=localStorage.getItem('read');",
  "var hist=raw?JSON.parse(raw):{};",
  "if(!hist[q]){hist[q]=[];}",
  "if(hist[q].indexOf(chapterId)<0){hist[q]=hist[q].concat([chapterId]);}",
  "localStorage.setItem('read',JSON.stringify(hist));",
  "}catch(e){}",
  "try{if(typeof _e===\"function\"){_e(q,chapterId);}}catch(e){}",
  "try{",
  "ye(function(prev){",
  "var cur=(prev&&prev[q])?prev[q]:[];",
  "if(cur.indexOf(chapterId)>=0){return prev;}",
  "var next={};for(var k in prev){if(Object.prototype.hasOwnProperty.call(prev,k)){next[k]=prev[k];}}",
  "next[q]=cur.concat([chapterId]);",
  "return next;",
  "});",
  "}catch(e){}",
  "},",

  /* 2) 目录高亮：把当前话指到新话，episode 同步到所在分页 */
  "setGroups:function(chapterId,sort){",
  "try{",
  "ve(function(prev){",
  "var menus=prev.menus||[];var ep=prev.episode;",
  "for(var i=0;i<menus.length;i++){",
  "var chunk=menus[i]||[];",
  "for(var j=0;j<chunk.length;j++){",
  "if(chunk[j]&&String(chunk[j].id)===String(chapterId)){ep=i;i=menus.length;break;}",
  "}",
  "}",
  "var nx={};for(var k in prev){if(Object.prototype.hasOwnProperty.call(prev,k)){nx[k]=prev[k];}}",
  "nx.subEpisode=sort;nx.currentChapterId=chapterId;",
  "if(ep!==undefined&&ep!==null&&ep>=0){nx.episode=ep;}",
  "return nx;",
  "});",
  "}catch(e){}",
  "},",

  /* 3) 标题：redux 的 readList.name 改不了，直接更新顶部标题节点文字 */
  "setTitle:function(name){",
  "try{",
  "if(!name)return;",
  "var el=pickTitle();",
  "if(el&&el.textContent!==name){el.textContent=name;}",
  "}catch(e){}",
  "},",

  /* 4) 插入后回调：把最新位置写进 read 键，详情页据此显示"继续阅读"
        注意：这里用运行时自己的 queryId（S.api.chapters.queryId），
        不依赖 hook 闭包里的 q（可能为 undefined）。 */
  "onInserted:function(payload){",
  "try{",
  "if(!payload||!payload.id)return;",
  "var cid=(typeof q!==\"undefined\"&&q)?q:((window.__JM_FLOW_API__&&window.__JM_FLOW_API__.queryId)||\"\");",
  "if(!cid)return;",
  "var raw=localStorage.getItem('read');",
  "var hist=raw?JSON.parse(raw):{};",
  "if(!hist[cid]){hist[cid]=[];}",
  "if(hist[cid].indexOf(payload.id)<0){hist[cid]=hist[cid].concat([payload.id]);}",
  "localStorage.setItem('read',JSON.stringify(hist));",
  "}catch(e){}",
  "}",
  "});",
  "});",

  /* E3: 换话（URL 变化）时清理运行时状态 */
  ";/*__JM_FLOW_HOOK2__*/",
  "(0,d.useEffect)(function(){",
  "var A=window.__JM_FLOW_API__;",
  "if(A&&A.onChapterChange){A.onChapterChange();}",
  "},[K]);"
].join("");

src = replaceOnce(src, ANCHOR, HOOK + ANCHOR, "E2");

/* ---------- E1: 内联运行时 ---------- */
const INLINE = "\n/* ==== JMComic3 continuous reading runtime (injected) ==== */\n" +
  runtime +
  "\n/* ==== end runtime ==== */\n";
const hi = src.indexOf(HEAD);
src = src.slice(0, hi + HEAD.length) + INLINE + src.slice(hi + HEAD.length);

try { new vm.Script(src, { filename: path.basename(chunkFile) }); }
catch (e) { fail("语法校验失败: " + e.message); }

fs.writeFileSync(chunkFile, src, "utf8");
console.log("[PATCH][OK] 写入完成，长度 " + src.length + " chars");
