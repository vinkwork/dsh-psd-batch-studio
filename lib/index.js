// 宿主侧：为「批量主图」面板提供文件通道，并把自然语言指令送进面板执行。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const name = "dsh-psd-batch-studio";
export const inject = ["tools", "webServer"];

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".psd", ".psb"]);
const TEMPLATE_EXT = new Set([".psd", ".psb", ".png", ".jpg", ".jpeg", ".webp"]);
const FONT_EXT = new Set([".ttf", ".otf", ".ttc", ".otc", ".woff", ".woff2"]);
const FILE_EXT = new Set([...TEMPLATE_EXT, ...FONT_EXT]);

let seq = 0;
const queue = [];
const waiters = [];
const pending = new Map();

function sendJson(res, code, body) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function dropWaiter(waiter) {
  clearTimeout(waiter.timer);
  const i = waiters.indexOf(waiter);
  if (i >= 0) waiters.splice(i, 1);
}

function deliver(cmd) {
  while (waiters.length) {
    const waiter = waiters.shift();
    clearTimeout(waiter.timer);
    if (!waiter.res.writableEnded) {
      sendJson(waiter.res, 200, cmd);
      return true;
    }
  }
  queue.push(cmd);
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 300 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function localOnly(req) {
  const remote = (req.socket && req.socket.remoteAddress) || "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function panelConnected() {
  return waiters.length > 0;
}

function runInPanel(payload, { timeout = 25000, writeDir = null } = {}) {
  const id = `bh${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(panelConnected()
        ? "面板没有回应，可能正忙，稍后再试。"
        : "批量主图面板还没打开。先在侧栏点开「批量主图」，再让我操作。"));
    }, timeout);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); pending.delete(id); resolve(value); },
      reject: (err) => { clearTimeout(timer); pending.delete(id); reject(err); },
    });
    deliver({ id, payload, writeDir });
  });
}

// 相对路径按会话工作目录解析；拿不到就用进程当前目录
async function sessionCwd(ctx, exec) {
  try {
    if (ctx && ctx.workingDirectory && exec && exec.agent) {
      const dir = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      if (typeof dir === "string" && dir) return dir;
    }
  } catch { /* 没这个服务就退回 */ }
  return process.cwd();
}

function fromCwd(cwd, candidate) {
  if (typeof candidate !== "string" || !candidate) return candidate;
  return path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
}

function safeFile(requested, allowed) {
  const abs = path.resolve(requested);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error("找不到文件：" + abs);
  const ext = path.extname(abs).toLowerCase();
  if (!allowed.has(ext)) throw new Error("不支持的文件类型：" + ext);
  return abs;
}

function registerRoutes(ctx) {
  const register = (urlPath, handler) => {
    ctx.webServer.register({
      kind: "exact",
      path: urlPath,
      handler: async (req, res) => {
        try {
          if (!localOnly(req)) {
            sendJson(res, 403, { ok: false, error: "只接受本机请求" });
            return;
          }
          await handler(req, res);
        } catch (err) {
          if (!res.writableEnded) sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      },
    });
  };

  register("/batch-hero/poll", async (req, res) => {
    if (req.method !== "GET") { sendJson(res, 405, { ok: false }); return; }
    if (queue.length) { sendJson(res, 200, queue.shift()); return; }
    const waiter = { res, timer: null };
    waiter.timer = setTimeout(() => {
      dropWaiter(waiter);
      if (!res.writableEnded) { res.statusCode = 204; res.end(); }
    }, 20000);
    waiters.push(waiter);
    req.on("close", () => dropWaiter(waiter));
  });

  register("/batch-hero/report", async (req, res) => {
    if (req.method !== "POST") { sendJson(res, 405, { ok: false }); return; }
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const entry = pending.get(body.id);
    if (entry) entry.resolve(body.result || {});
    sendJson(res, 200, { ok: true });
  });

  register("/batch-hero/file", async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const target = safeFile(url.searchParams.get("path") || "", FILE_EXT);
    const stat = await fsp.stat(target);
    const ext = path.extname(target).toLowerCase();
    res.statusCode = 200;
    const fontTypes = {
      ".ttf": "font/ttf", ".otf": "font/otf", ".ttc": "font/collection", ".otc": "font/collection",
      ".woff": "font/woff", ".woff2": "font/woff2",
    };
    res.setHeader("content-type", fontTypes[ext]
      || (ext === ".psd" || ext === ".psb" ? "image/vnd.adobe.photoshop"
        : ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg"));
    res.setHeader("content-length", String(stat.size));
    res.setHeader("cache-control", "no-store");
    fs.createReadStream(target).pipe(res);
  });

  register("/batch-hero/write", async (req, res) => {
    if (req.method !== "POST") { sendJson(res, 405, { ok: false }); return; }
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    const dir = String(body.dir || "");
    if (!dir) { sendJson(res, 400, { ok: false, error: "缺少目标目录" }); return; }
    await fsp.mkdir(dir, { recursive: true });
    const files = [];
    for (const item of body.images || []) {
      const name = path.basename(String(item.name || "image.jpg"));
      if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) continue;
      const dest = path.join(dir, name);
      await fsp.writeFile(dest, Buffer.from(String(item.base64 || ""), "base64"));
      files.push(dest);
    }
    sendJson(res, 200, { ok: true, dir, files });
  });

  register("/batch-hero/project", async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET") {
      const target = path.resolve(url.searchParams.get("path") || "");
      if (!fs.existsSync(target)) throw new Error("找不到工程文件：" + target);
      const text = await fsp.readFile(target, "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(text);
      return;
    }
    if (req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const target = path.resolve(String(body.path || ""));
      if (!target) throw new Error("缺少 path");
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, JSON.stringify(body.project, null, 2), "utf8");
      sendJson(res, 200, { ok: true, path: target });
      return;
    }
    sendJson(res, 405, { ok: false, error: "GET or POST" });
  });

  register("/batch-hero/ping", async (req, res) => {
    sendJson(res, 200, { ok: true, panel: panelConnected() });
  });
}

export function apply(ctx) {
  try {
    ctx.effect(() => {
      registerRoutes(ctx);
      return () => {};
    }, "batch-hero: routes");
  } catch (err) {
    console.error("[dsh-batch-hero] routes", err);
  }

  if (!ctx.tools) return;

  ctx.tools.register({
    name: "batch_hero",
    description: [
      "批量主图：驱动侧栏「批量主图」面板，用自然语言完成商品主图的批量替换。",
      "面板必须先在侧栏打开。action 取值：",
      "status 看当前模板 / 商品位 / SKU；",
      "open 打开 PSD 模板，传 path；",
      "import 导入抠图，传 dir；",
      "slot 设定商品位，传 layers（图层名数组），不传则按名字自动识别；",
      "place 调位置，可传 fit(height|width|contain|cover)、align(bottom|center|top)、ratio、dx、dy、scale、rotation，scope=all 时套用到全部 SKU；",
      "select 选一张 SKU，传 name 或 index；",
      "layer 改模板里的图层：传 names（图层名或「组/图/层」路径），可设 followWidth（宽度跟随商品）、hidden（隐藏）、front（盖在商品上面）、scaleX/scaleY/rotation/dx/dy（变换）、slotDX/slotDY（商品位整体偏移）、opacity（不透明度 0-100 或 0-1）、blend（16 种混合模式）、tint + tintStrength（颜色叠加）、brightness/contrast/saturate/hue/blur（亮度/对比度/饱和度/色相/模糊）、text（改文字）、font（字体）、fontSize（按画面像素，和面板一致）、fontSizePt、weight（字重）、tracking（字距）、leading（行高）、color（文字颜色 #rrggbb）、align（left/center/right）、reset（还原变换）、resetLook（还原不透明度/混合/颜色效果）。说「某层要和商品对齐宽度」用 followWidth:true；说「换品牌色」用 tint；说「调亮/糊一点/换色调」用 brightness/blur/hue；",
      "close 卸掉当前模板（保留已经导入的商品要素），换模板前先 close 或直接再 open 一个；",
      "view 调画布视野，mode=fit（适应窗口）/center（回中心）/100（实际像素）/zoom（配合 zoom，1 或 100 都行）；",
      "format 设导出格式：format=png/jpg/webp/bmp/psd/psb，可带 quality（0.1-1 或 1-100）、longEdge（长边像素）、square（true 出正方形）；",
      "undo / redo 撤销重做；clearskus 清空所有商品要素；remsku 删掉一张（传 name 或 index）；",
      "slot 设商品位，mode=set（默认覆盖）/add（追加）/clear（清空）；showSlots 传 show 控制画布上的商品位框；",
      "element 往模板里置入图片图层（传 dir 或 paths），remelement 删元素图层（传 names）；",
      "fonts 注册本地字体给面板（传 dir 或 paths，支持 ttf/otf/ttc/woff），注册后就能用 layer 的 font 参数给文字层换字体；",
      "export 导出，传 dir、all（true 导全部）；",
      "save_project 把当前工程（商品位、图层变换、文字改动、每张 SKU 的参数）存成 path 指定的 json；",
      "load_project 读回 path 指定的工程，模板路径也在里面时会自动重新打开。",
      "典型流程：open → slot → import → place(scope=all) → export(all=true)。",
      "参数里的 ratio 用小数，0.9 就是 90%；path/dir 可以写绝对路径，也可以写相对当前工作目录的路径。",
    ].join("\n"),
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["status", "open", "import", "slot", "place", "select", "layer", "inspect", "view", "fonts", "format", "undo", "redo", "clearskus", "remsku", "showSlots", "element", "remelement", "close", "export", "save_project", "load_project"] },
        paths: { type: "array", items: { type: "string" }, description: "字体文件路径列表（action=fonts）" },
        names: { type: "array", items: { type: "string" }, description: "要改的图层名，或「组/组/图层」路径（action=layer）" },
        runs: {
          type: "array",
          description: "按 run 精确排版（action=layer）：[{len,family,weight,size,sizePx,color,tracking}]，len 是字符数；sizePx 按画面像素给字号，用它做价格小数点变小",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              len: { type: "number" },
              family: { type: "string" },
              weight: { type: "number" },
              size: { type: "number" },
              sizePx: { type: "number" },
              color: { type: "string" },
              tracking: { type: "number" },
            },
            required: ["len"],
          },
        },
        followWidth: { type: "boolean", description: "宽度跟随商品，导出时按每张商品的宽度重算（action=layer）" },
        hidden: { type: "boolean" },
        front: { type: "boolean", description: "画在商品上面" },
        scaleX: { type: "number" },
        scaleY: { type: "number" },
        dx: { type: "number" },
        dy: { type: "number" },
        text: { type: "string", description: "改写文字层内容（action=layer）" },
        opacity: { type: "number", description: "图层不透明度，0-100（也接受 0-1）（action=layer）" },
        tint: { type: "string", description: "颜色叠加的十六进制颜色，如 #ff3b30；传 null 取消（action=layer）" },
        tintStrength: { type: "number", description: "颜色叠加强度，0-100（也接受 0-1）（action=layer）" },
        brightness: { type: "number", description: "亮度百分比，100 为原样（action=layer）" },
        contrast: { type: "number", description: "对比度百分比，100 为原样（action=layer）" },
        saturate: { type: "number", description: "饱和度百分比，100 为原样（action=layer）" },
        hue: { type: "number", description: "色相旋转角度，-180 到 180（action=layer）" },
        blur: { type: "number", description: "模糊半径（像素，0-20）（action=layer）" },
        blend: { type: "string", description: "图层混合模式，如 multiply / screen / overlay / darken / lighten（action=layer）" },
        font: { type: "string", description: "文字层换成这个字体（需先用 fonts 注册）（action=layer）" },
        fontSize: { type: "number", description: "文字层字号（pt，改完不会影响其他行）（action=layer）" },
        reset: { type: "boolean", description: "把这些图层的变换还原（action=layer）" },
        resetLook: { type: "boolean", description: "不透明度与混合模式还原成模板原值（action=layer）" },
        mode: { type: "string", enum: ["fit", "center", "100", "zoom"], description: "画布视野模式（action=view）" },
        zoom: { type: "number", description: "action=view 且 mode=zoom 时用，1 或 100 都表示 100%" },
        format: { type: "string", description: "导出格式 png/jpg/webp/bmp/psd/psb（action=format）" },
        quality: { type: "number", description: "有损格式质量，0.1-1 或 1-100（action=format）" },
        longEdge: { type: "number", description: "导出长边像素，0 表示原尺寸（action=format）" },
        square: { type: "boolean", description: "导出成正方形（action=format）" },
        show: { type: "boolean", description: "action=showSlots 时控制显示/隐藏商品位框" },
        mode: { type: "string", description: "action=slot：set/add/clear" },
        weight: { type: "number", description: "文字字重 100-900（action=layer）" },
        tracking: { type: "number", description: "字距（action=layer）" },
        leading: { type: "number", description: "行高（action=layer）" },
        color: { type: "string", description: "文字颜色，如 #ff3b30（action=layer）" },
        align: { type: "string", description: "文字对齐 left/center/right（action=layer）" },
        fontSizePt: { type: "number", description: "字号（pt 内部单位）（action=layer）" },
        slotDX: { type: "number", description: "商品位水平偏移（action=layer）" },
        slotDY: { type: "number", description: "商品位垂直偏移（action=layer）" },
        keepSkus: { type: "boolean", description: "action=close 时是否保留商品要素，默认 true" },
        path: { type: "string", description: "模板文件绝对路径（action=open）" },
        dir: { type: "string", description: "SKU 目录（import）或导出目录（export）" },
        layers: { type: "array", items: { type: "string" }, description: "商品位图层名" },
        fit: { type: "string", enum: ["height", "width", "contain", "cover"] },
        align: { type: "string", enum: ["bottom", "center", "top"] },
        ratio: { type: "number", description: "占位比例，0.9 表示 90%" },
        dx: { type: "number" },
        dy: { type: "number" },
        scale: { type: "number" },
        rotation: { type: "number" },
        scope: { type: "string", enum: ["current", "all"] },
        name: { type: "string" },
        index: { type: "number" },
        all: { type: "boolean" },
      },
      required: ["action"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: String((value && value.text) || "") }],
    },
    async execute(args, exec) {
      const action = String((args && args.action) || "");
      const cwd = await sessionCwd(ctx, exec);
      try {
        if (action === "open") {
          if (!args.path) throw new Error("open 需要 path");
          const abs = safeFile(fromCwd(cwd, args.path), TEMPLATE_EXT);
          const result = await runInPanel({
            action: "open",
            name: path.basename(abs),
            path: abs,
            url: `/batch-hero/file?path=${encodeURIComponent(abs)}`,
          }, { timeout: 120000 });
          if (result.error) throw new Error(result.error);
          return { text: `已打开 ${path.basename(abs)}，${result.template.width}×${result.template.height}，自动识别商品位 ${result.slots} 个。` };
        }

        if (action === "import") {
          if (!args.dir) throw new Error("import 需要 dir");
          const root = path.resolve(cwd, args.dir);
          const files = [];
          const walk = async (dir, prefix) => {
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.name.startsWith(".")) continue;
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) await walk(full, prefix + entry.name + "/");
              else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
                files.push({ name: prefix + entry.name, url: `/batch-hero/file?path=${encodeURIComponent(full)}` });
              }
            }
          };
          await walk(root, "");
          if (!files.length) throw new Error("这个目录里没有 png/jpg/webp");
          const result = await runInPanel({ action: "import", files }, { timeout: 240000 });
          if (result.error) throw new Error(result.error);
          return { text: `已导入 ${result.count} 张 SKU。` };
        }

        if (action === "slot") {
          const result = await runInPanel({ action: "slot", layers: args.layers || [], mode: args.mode || "set" });
          if (result.error) throw new Error(result.error);
          const sup = Array.isArray(result.suppress) ? result.suppress : [];
          const tail = sup.length ? `\n同时排除同组重叠层 ${sup.length} 个：${sup.join("、")}` : "";
          return { text: result.slots.length ? `商品位：${result.slots.join("、")}${tail}` : "没找到对应图层，检查一下名字。" };
        }

        if (action === "place") {
          const payload = { action: "place", scope: args.scope || "current" };
          for (const key of ["fit", "align", "ratio", "dx", "dy", "scale", "rotation"]) {
            if (args[key] != null) payload[key] = args[key];
          }
          const result = await runInPanel(payload);
          if (result.error) throw new Error(result.error);
          const p = result.placement;
          return { text: `位置已更新：${p.fit} / ${p.align} / 占位 ${Math.round(p.ratio * 100)}% / 偏移 ${Math.round(p.dx)},${Math.round(p.dy)} / 缩放 ${Math.round(p.scale * 100)}% / 角度 ${Math.round(p.rotation)}°` };
        }

        if (action === "select") {
          const result = await runInPanel({ action: "select", name: args.name, index: args.index });
          if (result.error) throw new Error(result.error);
          return { text: `当前 SKU：${result.current}` };
        }

        if (action === "view") {
          if (!args.mode && args.zoom == null) throw new Error("view 需要 mode 或 zoom");
          const result = await runInPanel({ action: "view", mode: args.mode, zoom: args.zoom }, { timeout: 15000 });
          if (result.error) throw new Error(result.error);
          return { text: `视野：${result.mode}，当前 ${Math.round(result.zoom * 100)}%` };
        }

        if (action === "fonts") {
          const inputs = [];
          if (Array.isArray(args.paths)) inputs.push(...args.paths);
          if (args.dir) inputs.push(args.dir);
          if (!inputs.length) throw new Error("fonts 需要 dir 或 paths");
          const files = [];
          const pushFont = (full) => {
            if (!FONT_EXT.has(path.extname(full).toLowerCase())) return;
            const family = path.basename(full).replace(/\.(ttf|otf|ttc|otc|woff2?)$/i, "").replace(/[_]+/g, " ").trim();
            files.push({ family, url: `/batch-hero/file?path=${encodeURIComponent(full)}` });
          };
          for (const raw of inputs) {
            const abs = path.resolve(cwd, raw);
            if (!fs.existsSync(abs)) throw new Error("找不到字体路径：" + abs);
            if (fs.statSync(abs).isDirectory()) {
              for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
                if (!entry.isFile() || entry.name.startsWith(".")) continue;
                pushFont(path.join(abs, entry.name));
              }
            } else pushFont(abs);
          }
          if (!files.length) throw new Error("这些路径里没有 ttf/otf/ttc/woff 字体");
          const result = await runInPanel({ action: "fonts", fonts: files }, { timeout: 120000 });
          if (result.error) throw new Error(result.error);
          const repaint = result.repainted ? `，已重绘 ${result.repainted} 个文字层` : "";
          return { text: `已注册 ${result.loaded.length} 个字体${repaint}` + (result.failed.length ? `，${result.failed.length} 个读不了：${result.failed.slice(0, 6).join("、")}` : "") };
        }

        if (action === "undo" || action === "redo" || action === "clearskus") {
          const result = await runInPanel({ action }, { timeout: 20000 });
          if (result.error) throw new Error(result.error);
          const label = action === "undo" ? "已撤销" : action === "redo" ? "已重做" : "商品要素已清空";
          return { text: label + (action === "clearskus" ? "。" : `，还能撤销 ${result.canUndo} 步 / 重做 ${result.canRedo} 步。`) };
        }

        if (action === "remsku") {
          if (args.name == null && args.index == null) throw new Error("remsku 需要 name 或 index");
          const result = await runInPanel({ action: "remsku", name: args.name, index: args.index }, { timeout: 20000 });
          if (result.error) throw new Error(result.error);
          return { text: `已删掉 ${result.removed}，还剩 ${result.skus} 张。` };
        }

        if (action === "format") {
          if (!args.format) throw new Error("format 需要 format 参数");
          const result = await runInPanel({
            action: "format",
            format: args.format,
            quality: args.quality,
            longEdge: args.longEdge,
            square: args.square,
          }, { timeout: 15000 });
          if (result.error) throw new Error(result.error);
          const bits = [`导出格式：${result.format.toUpperCase()}`];
          if (result.quality != null) bits.push(`质量 ${Math.round(result.quality * 100)}%`);
          if (result.longEdge) bits.push(`长边 ${result.longEdge}px`);
          if (result.square) bits.push("正方形");
          return { text: bits.join("，") + "。" };
        }

        if (action === "showSlots") {
          const result = await runInPanel({ action: "showSlots", show: args.show !== false }, { timeout: 15000 });
          if (result.error) throw new Error(result.error);
          return { text: result.showSlots ? "已显示商品位框。" : "已隐藏商品位框。" };
        }

        if (action === "element" || action === "remelement") {
          if (action === "remelement") {
            const names = args.names || (args.name ? [args.name] : []);
            if (!names.length) throw new Error("remelement 需要 names");
            const result = await runInPanel({ action: "remelement", names }, { timeout: 20000 });
            if (result.error) throw new Error(result.error);
            return { text: `已删元素图层：${result.removed.join("、")}` };
          }
          const inputs = [];
          if (Array.isArray(args.paths)) inputs.push(...args.paths);
          if (args.dir) inputs.push(args.dir);
          if (!inputs.length) throw new Error("element 需要 dir 或 paths");
          const files = [];
          const pushImg = (full) => {
            if (!IMAGE_EXT.has(path.extname(full).toLowerCase())) return;
            files.push({ name: path.basename(full), url: `/batch-hero/file?path=${encodeURIComponent(full)}` });
          };
          for (const raw of inputs) {
            const abs = path.resolve(cwd, raw);
            if (!fs.existsSync(abs)) throw new Error("找不到路径：" + abs);
            if (fs.statSync(abs).isDirectory()) {
              for (const entry of await fsp.readdir(abs, { withFileTypes: true })) {
                if (entry.isFile() && !entry.name.startsWith(".")) pushImg(path.join(abs, entry.name));
              }
            } else pushImg(abs);
          }
          if (!files.length) throw new Error("这些路径里没有 png/jpg/webp");
          const result = await runInPanel({ action: "element", files }, { timeout: 120000 });
          if (result.error) throw new Error(result.error);
          return { text: `已置入 ${result.added} 个元素图层，模板里现在有 ${result.elements} 个元素。` };
        }

        if (action === "close") {
          const result = await runInPanel({ action: "close", keepSkus: args.keepSkus !== false }, { timeout: 20000 });
          if (result.error) throw new Error(result.error);
          return { text: result.had ? `模板已卸下，商品要素还剩 ${result.skus} 张。` : "本来就没载入模板。" };
        }

        if (action === "save_project") {
          if (!args.dir && !args.path) throw new Error("save_project 需要 path");
          const raw = args.path || path.join(args.dir || "", "主图工程.json");
          const target = path.resolve(cwd, raw);
          const result = await runInPanel({ action: "project" }, { timeout: 30000 });
          if (result.error) throw new Error(result.error);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, JSON.stringify(result.project, null, 2), "utf8");
          return { text: `工程已保存到 ${target}` };
        }

        if (action === "load_project") {
          if (!args.path) throw new Error("load_project 需要 path");
          const target = path.resolve(cwd, args.path);
          if (!fs.existsSync(target)) throw new Error("找不到工程文件：" + target);
          const project = JSON.parse(await fsp.readFile(target, "utf8"));
          const result = await runInPanel({ action: "project-load", project }, { timeout: 180000 });
          if (result.error) throw new Error(result.error);
          return { text: `工程已载入：图层 ${result.layers} 处改动，商品位 ${result.slots} 个。` };
        }

        if (action === "layer") {
          const payload = { action: "layer", names: args.names || (args.name ? [args.name] : []) };
          for (const key of ["followWidth", "hidden", "front", "scaleX", "scaleY", "rotation", "dx", "dy", "slotDX", "slotDY", "text", "font", "fontSize", "fontSizePt", "weight", "tracking", "leading", "color", "align", "opacity", "blend", "tint", "tintStrength", "brightness", "contrast", "saturate", "hue", "blur", "reset", "resetLook", "runs"]) {
            if (args[key] != null) payload[key] = args[key];
          }
          const result = await runInPanel(payload, { timeout: 20000 });
          if (result.error) throw new Error(result.error);
          const extra = [];
          if (Array.isArray(result.warn) && result.warn.length) extra.push("注意：" + result.warn.join("；"));
          return { text: `已改：${(result.layers || []).join("、")}${extra.length ? "\n" + extra.join("\n") : ""}` };
        }

        if (action === "inspect") {
          const result = await runInPanel(
            { action: "inspect", names: args.names || (args.name ? [args.name] : []) },
            { timeout: 20000 },
          );
          if (result.error) throw new Error(result.error);
          const rows = (result.layers || []).map((l) => {
            const head = `${l.path}${l.isSlot ? "［商品位］" : ""}${l.hidden ? "［隐藏］" : ""}${l.psdHidden ? "［PSD原隐藏］" : ""}${l.suppressed ? "［已排除］" : ""}`;
            const body = l.runs && l.runs.length
              ? l.runs.map((r) => `    ${r.len}字 ${r.family || "?"} w${r.weight || "?"} ${r.px || "?"}px${r.registered ? "" : "（字体未注册！）"}`).join("\n")
              : `    ${l.kind} bbox=${l.bbox ? `${l.bbox.x},${l.bbox.y} ${l.bbox.w}×${l.bbox.h}` : "?"}`;
            return `${head}\n${l.text != null ? `    text=${JSON.stringify(l.text)}\n` : ""}${body}`;
          });
          return { text: `共 ${result.count} 层：\n${rows.join("\n")}` };
        }

        if (action === "export") {
          if (!args.dir) throw new Error("export 需要 dir");
          const outDir = path.resolve(cwd, args.dir);
          const result = await runInPanel(
            { action: "export", all: args.all !== false },
            { timeout: 300000, writeDir: outDir },
          );
          if (result.error) throw new Error(result.error);
          if (result.writeError) throw new Error("写文件失败：" + result.writeError);
          const written = (result.written && result.written.files) || [];
          return { text: `已导出 ${written.length} 张到 ${outDir}。` };
        }

        const status = await runInPanel({ action: "status" }, { timeout: 15000 });
        if (status.error) throw new Error(status.error);
        const lines = [];
        lines.push(status.template ? `模板：${status.template.name} ${status.template.width}×${status.template.height}` : "模板：未载入");
        lines.push(`图层 ${status.layers} 个，商品位 ${status.slots.length} 个${status.slots.length ? "：" + status.slots.map((s) => s.name).join("、") : ""}`);
        lines.push(`SKU ${status.skus} 张${status.current ? "，当前 " + status.current : ""}`);
        const p = status.placement || {};
        lines.push(`位置：${p.fit} / ${p.align} / 占位 ${Math.round((p.ratio || 0) * 100)}% / 偏移 ${Math.round(p.dx || 0)},${Math.round(p.dy || 0)}`);
        if (status.picked) lines.push(`选中的图层：${status.picked}`);
        if (status.pickedLook) {
          const k = status.pickedLook;
          lines.push(`图层外观：不透明度 ${Math.round(k.opacity * 100)}% / 混合 ${k.blend}${k.hidden ? " / 已隐藏" : ""}`);
        }
        if (status.view) lines.push(`视野：${Math.round(status.view.zoom * 100)}%${status.view.fitted ? "（适应窗口）" : ""}`);
        return { text: lines.join("\n") };
      } catch (err) {
        return { text: "ERROR: " + String((err && err.message) || err) };
      }
    },
  });
}
