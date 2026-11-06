# 安装 dsh-batch-hero（批量主图）

DeepSeek Harness 的插件就是一个 npm 包 + 一个 profile 条目，不需要编译，也不要装 `node_modules`：客户端 `client.js` 已经打好包（含 ag-psd），宿主侧 `lib/index.js` 只依赖 Node 内置模块。

## 目录约定

```
~/.dsh/
├── plugins/
│   └── dsh-batch-hero/          ← 插件本体放在这里（也可以是任意路径）
└── profiles/
    └── desktop/                 ← 你的 profile 名，可能叫别的
        ├── package.json         ← 要在这里登记插件
        └── node_modules/
            └── dsh-batch-hero → 符号链接指到 plugins 目录
```

## 一键安装

```bash
# 1) 解压到插件目录
mkdir -p ~/.dsh/plugins
tar xzf dsh-batch-hero-1.0.0.tgz -C ~/.dsh/plugins
# 得到 ~/.dsh/plugins/dsh-batch-hero/

# 2) 跑安装脚本（会改 profile 的 package.json 并执行 install）
cd ~/.dsh/plugins/dsh-batch-hero
bash install.sh            # 默认 profile=desktop
# 或者指定 profile：bash install.sh work
```

装完**完全退出** DeepSeek Harness 再打开（宿主侧代码只在启动时加载）。

## 手动安装

1. 把插件目录放到 `~/.dsh/plugins/dsh-batch-hero`（路径随意，下面用相对路径指过去）。

2. 编辑 `~/.dsh/profiles/<profile>/package.json`：

```jsonc
{
  "dependencies": {
    // 加这一行，路径相对于 profile 目录
    "dsh-batch-hero": "file:../../plugins/dsh-batch-hero"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-batch-hero"          // ← 加这一项
      ]
    }
  }
}
```

3. 在该 profile 目录里执行安装（让它建出 node_modules 链接）：

```bash
cd ~/.dsh/profiles/<profile>
npm install     # 或 pnpm install，取决于你的 profile 用的包管理器
```

4. 确认是**符号链接**而不是拷贝：

```bash
ls -ld ~/.dsh/profiles/<profile>/node_modules/dsh-batch-hero
# 期望看到 -> /Users/<you>/.dsh/plugins/dsh-batch-hero
```

5. 完全退出并重开 DeepSeek Harness。

## 怎么用

打开侧栏的「批量主图」面板：

1. 拖入 PSD / PSB 模板（自动按图层名识别商品位，也可在左栏点 ◎ 手动标）；
2. 右栏「＋ 添加商品图」导入抠图（PNG/JPG/WebP，可多选或整文件夹）；
3. 中间画布调整位置，右栏微调适配方式 / 占位比例 / 偏移；
4. 顶栏选导出格式（PNG / JPG / WebP / BMP / PSD / PSB），「导出全部」。

也可以让 AI 直接驱动（工具名 `batch_hero`）：`open → slot → import → place → export`。

## 兼容性

- 需要 dsh 版本提供 `@deepseek-ai/dsh-client-ui-slots`（`dshTarget: 0.2.0-rc.2`）。
- 宿主侧：`inject = ["tools", "webServer"]`，只监听本机 `127.0.0.1`。
- 不渲染的 PSD 效果：内发光、斜面和浮雕、图案叠加；其余（投影、外发光、纯色/渐变叠加、描边、内阴影、剪贴蒙版）都支持。
- 字体导入：文件菜单 →「导入字体…」，支持 ttf / otf / ttc / woff。
