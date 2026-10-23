/* eslint-disable */
/**
 * JMComic3 APK 打包器（Node，无第三方依赖）
 *
 * 直接从原始 repo.zip 读取条目，绕开 Windows 大小写不敏感导致的
 * res 文件互相覆盖问题；同时把打了补丁的 chunk 替换进去。
 *
 * 用法:
 *   node pack.js <repo.zip> <patchedChunkFile> <outApk>
 */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

/* ---------------- CRC32 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ---------------- 极简 ZIP 读取 ---------------- */
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const entries = new Map();

  // 找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip: 找不到 EOCD");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);

    // 读本地头拿到真实数据起点
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("本地头损坏: " + name);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;

    let data = buf.subarray(dataOff, dataOff + compSize);
    if (method === 8) data = zlib.inflateRawSync(data);
    else if (method !== 0) throw new Error("不支持的压缩方式 " + method + ": " + name);

    if (data.length !== uncompSize) throw new Error("长度不符: " + name);
    if (crc32(data) !== crc) throw new Error("CRC 不符: " + name);

    entries.set(name, data);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/* ---------------- ZIP 写出 ---------------- */
const STORE_EXT = /\.(png|jpe?g|gif|webp|mp3|mp4|ogg|wav|zip)$/i;

function buildZip(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const store = name === "resources.arsc" || name === "classes.dex" || STORE_EXT.test(name);

    const crc = crc32(data);
    const payload = store ? data : zlib.deflateRawSync(data, { level: 9 });
    const method = store ? 0 : 8;
    const flags = 0x0800; // UTF-8 文件名

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(payload.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    chunks.push(lh, nameBuf, payload);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(dosTime, 12);
    cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);

    central.push(cd, nameBuf);
    offset += lh.length + nameBuf.length + payload.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...chunks, cdBuf, eocd]));
}

/* ---------------- 主流程 ---------------- */
function main() {
  const [zipPath, patchedChunk, outApk] = process.argv.slice(2);
  if (!zipPath || !patchedChunk || !outApk) {
    console.error("用法: node pack.js <repo.zip> <patchedChunkFile> <outApk>");
    process.exit(1);
  }

  const src = readZipEntries(zipPath);
  console.log("[PACK] 源 zip 条目数: " + src.size);

  const ROOT = "JMComic3-APK-NO-Ads-main/";
  const PATCHED_NAME = ROOT + "assets/public/static/js/" + path.basename(patchedChunk);
  const patchedBuf = fs.readFileSync(patchedChunk);

  const DROP_ROOT = new Set([
    "README.md", "CONTRIBUTING.md", "LICENSE", ".gitignore",
    // 旧签名：必须删除，否则 apksigner 会与残留签名冲突
    "META-INF/CERT.RSA", "META-INF/CERT.SF", "META-INF/MANIFEST.MF"
  ]);

  const out = new Map();

  // 顺序：resources.arsc 与 classes.dex 放最前，便于对齐
  const ordered = [];
  ordered.push("resources.arsc", "classes.dex", "AndroidManifest.xml", "DebugProbesKt.bin");

  const rest = [];
  for (const name of src.keys()) {
    if (!name.startsWith(ROOT)) continue;
    let rel = name.slice(ROOT.length);
    if (!rel) continue;

    // 排除目录本身
    if (rel.endsWith("/")) continue;
    if (rel.startsWith(".github/")) continue;
    if (rel.startsWith("skills/")) continue;
    if (DROP_ROOT.has(rel)) continue;
    if (rel.endsWith(".map")) continue;

    // res_extra/res/xxx -> res/xxx
    if (rel.startsWith("res_extra/")) {
      rel = rel.slice("res_extra/".length);
    }
    rest.push([rel, name]);
  }

  for (const base of ordered) {
    const key = ROOT + base;
    if (!src.has(key)) throw new Error("缺少必需文件: " + base);
    out.set(base, src.get(key));
  }

  let resExtra = 0;
  for (const [rel, origName] of rest) {
    if (out.has(rel)) {
      // res_extra 注入：同路径已存在则跳过（与 CI 行为一致）
      if (origName.indexOf("/res_extra/") >= 0) { continue; }
    }
    let buf = src.get(origName);

    // 替换补丁后的 chunk
    if (origName === PATCHED_NAME) {
      buf = patchedBuf;
      console.log("[PACK] 已替换补丁 chunk: " + rel);
    }

    if (origName.indexOf("/res_extra/") >= 0) resExtra++;
    out.set(rel, buf);
  }

  console.log("[PACK] 图标/res 条目: " + [...out.keys()].filter(k => k.startsWith("res/")).length);
  console.log("[PACK] res_extra 注入: " + resExtra);
  console.log("[PACK] 总条目: " + out.size);

  const hookPath = "assets/public/static/js/" + path.basename(patchedChunk);
  const inApk = out.get(hookPath);
  const inApkText = inApk ? inApk.toString("utf8") : "";
  if (!inApk ||
      inApkText.indexOf("__JM_FLOW_HOOK__") < 0 ||
      inApkText.indexOf("window.__JM_FLOW_API__") < 0) {
    throw new Error("补丁未进入 APK: " + hookPath);
  }
  console.log("[PACK] 校验通过: APK 内的 chunk 含连续阅读补丁");

  buildZip(out, outApk);
  const size = fs.statSync(outApk).size;
  console.log("[PACK][OK] " + outApk + "  " + (size / 1024 / 1024).toFixed(2) + " MB");
}

main();
