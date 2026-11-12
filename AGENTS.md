# 仓库开发说明（给 agent）

这个仓库是 **dsh-psd-batch-studio**：一个 PSD 批量出图引擎，带两种入口——
dsh 插件（`index.js` + `server.js` + `client.js`）和命令行（`bin/psd.mjs`）。
对外使用者的目录约定和操作流程在 [docs/agent-workflow.md](docs/agent-workflow.md)，那是给**使用者项目**看的，
不要和本文件混用。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/core/` | 合成内核：PSD 解析、图层角色、规则、需求表、文字重绘、校验 |
| `src/client/` | 浏览器面板（React + canvas） |
| `src/server.js` | Host 侧渲染与 agent 工具注册 |
| `bin/psd.mjs` | 命令行入口（preflight / draft / render / view / check / tool） |
| `server.js` / `client.js` | **构建产物，不要手改**，由 `npm run build` 生成 |
| `docs/` | 使用文档：agent 工作流、踩坑记录、教程 |
| `examples/` | 需求表空白模板、示例 rules.json |
| `assets/fonts/` | 模板用到的开源字体（MiSans / GlowSans；苹果系统字体不入库） |

## 命令

```bash
npm ci            # 装依赖（@napi-rs/canvas 是 native，装不上先看 node -v ≥ 20）
npm run build     # 重新生成 client.js + server.js
npm test          # rules / preflight / smoke / dsh-host 四组测试
```

## 规矩

- 改完 `src/` **必须** `npm run build` 再提交，产物与源码要同一个 commit。
- 不提交 PSD/PSB、产品图、赠品图、输出；`assets/fonts/` 只放许可允许再分发的字体。
- 面向使用者的行为变更要同步 `README.md`、`README.en.md` 和 `docs/agent-workflow.md`。
- 版本号用 semver，改完核对 `package.json` 与 `package-lock.json` 一致。
