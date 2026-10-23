/* eslint-disable */
/**
 * JMComic3 连续阅读补丁（严格手势版）
 *
 * 用法: node patch3.js <chunkFile> <runtimeFile>
 *
 * E0 模块作用域取出 App API 层引用
 *    （组件内有 `var e,t,s;` 遮蔽了 webpack require 的 s）
 * E1 顶部内联 flow-runtime.js
 * E2 阅读组件 render 前插入 useEffect：注入 API 层 + 章节信息
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
if (!chunkFile || !runtimeFile) fail("用法: node patch3.js <chunkFile> <runtimeFile>");

let src = fs.readFileSync(chunkFile, "utf8");
const runtime = fs.readFileSync(runtimeFile, "utf8");

console.log("[PATCH] chunk   = " + path.basename(chunkFile) + " (" + src.length + " chars)");
console.log("[PATCH] runtime = " + path.basename(runtimeFile) + " (" + runtime.length + " chars)");

if (src.indexOf("__JM_FLOW_HOOK__") >= 0) fail("该 chunk 已打过补丁");
if (src.indexOf("__JM_CN_HOOK__") >= 0) fail("检测到旧补丁(CN)，请用原始 chunk");
if (src.indexOf("__JM_AF_HOOK__") >= 0) fail("检测到旧补丁(AF)，请用原始 chunk");

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
 *   q=queryId K=readId P=detailList R=isLoading S=dialogOpen
 *   ue=closeNav me=setCloseNav m=config
 */
const HOOK = [
  ";/*__JM_FLOW_HOOK__*/",
  "(0,d.useEffect)(function(){",
  "var A=window.__JM_FLOW_API__;",
  "if(!A)return;",
  "A.setApi({",
  "getApiEndpoint:JMFLOW_EP,",
  "fetchGet:JMFLOW_HTTP.fetchGet,",
  "scramble:JMFLOW_SCR,",
  "express:(m&&m.express)||\"\",",
  "chapters:{series:P.series||[],readId:K,queryId:q},",
  "toggleNav:function(){try{me(function(v){return !v;});}catch(e){}},",
  "onInserted:function(payload){",
  "try{if(typeof _e===\"function\"&&payload&&payload.id){_e(q,payload.id);}}catch(e){}",
  "}",
  "});",
  "});",
  /* E3: 换话时清理 */
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
