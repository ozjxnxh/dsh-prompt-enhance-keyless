# 提示词增强插件 (dsh-prompt-enhance)

给 DSH 输入框工具栏（模型选择器左侧）增加一枚「增强提示词」✨ 按钮，并在设置页里选择改写所用的模型来源。

## 功能

- **增强按钮**：点击把当前草稿发给 Host 改写，结果回填草稿；成功后短暂显示「撤销」，可一键还原原文。
- **设置页**：出现在 DSH 设置侧栏「提示词增强」，提供两个通道选项并说明限制。
  - **对话模型**：用当前会话所选模型改写，质量最高、按模型额度计费。
  - **Pollinations 免登录通道**：无需登录、不消耗额度，受**每 30 秒 1 次**请求限制。
- **语言一致**：改写结果始终保持与输入相同的语言（中文→中文、英文→英文、日文→日文）。
- **30 秒冷却自动切换**：冷却期间点击不会失败——自动改用当前对话模型完成改写；冷却结束后，下一次点击自动切回 Pollinations 免登录通道，无需手动切换。插件在本地记录上次调用时间，上游真的返回配额拒绝（402）时也会关闭本地窗口，不浪费任何请求。

## 目录结构

```
提示词增强插件/
├── index.js              Host 半身：路由 + 两条生成通道
├── client.js             浏览器半身：输入框按钮 + 设置页区块
├── package.json          包声明（dsh.bundle / dsh.client）
├── cordis.patch.yml      bundle 层挂载配置
├── icon.svg              图标
├── README.md             本文件
├── src/
│   ├── language.js       语言检测、语言锁定、原文细节保留
│   ├── keyless.js        Pollinations 免登录通道适配器
│   ├── settings.js       通道选择的持久化与本地限流
│   └── settings-view.js  设置界面组件源码
├── test/
│   ├── language.test.js  语言一致性 + 中文误输出日文回归
│   ├── route.test.js     路由级语言断言
│   └── settings.test.js  设置持久化与 30 秒限流
└── .runtime/             运行时状态（自动生成，勿提交）
```

## 接口

| 方法与路径 | 作用 |
|---|---|
| `POST /api/prompt-enhance/enhance` | 改写一段草稿，返回 `{ ok, enhanced, lane, fallback? }`，`lane` 为实际通道，`fallback` 说明为何回退 |
| `GET /api/prompt-enhance/settings` | 读取当前通道与限制说明 |
| `POST /api/prompt-enhance/settings` | 保存通道 `{ provider: 'model' \| 'keyless' \| 'auto' }` |

## 安装

把本目录链接进 DSH profile（`~/.dsh/profiles/desktop`）：

1. `package.json` 的 `dependencies` 加 `"dsh-prompt-enhance": "link:E:/提示词增强插件"`
2. `dsh.profile.bundles` 加入 `dsh-prompt-enhance`
3. 在 `node_modules/` 下建立指向本目录的 junction
4. 重启 DSH NEXT

## 测试

```bash
node --test test/language.test.js test/route.test.js test/settings.test.js
```

## 一个已知前提

Host 端代码改动需要**重启 DSH NEXT** 才会生效：Cordis 的配置热重载只重新执行插件，不会重新导入已缓存的 ES 模块。浏览器半身（`client.js`）则支持基于文件元数据的热更新。
