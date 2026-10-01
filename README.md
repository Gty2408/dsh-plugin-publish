# dsh-plugin-publish

一条命令把 DSH 插件发布到 GitHub。产出一个公开仓库，任何其他机器都能从它安装这个插件。

```sh
npx dsh-plugin-publish ./my-plugin --token <token> --yes
```

## 它做什么

1. **在本地校验插件** —— 在任何网络请求之前。
2. 创建 GitHub 仓库（已存在则复用）。
3. 把整棵目录树作为**一个提交**上传。
4. 设置 `dsh-plugin` topic（保留你已有的 topic）。
5. **打印在其他机器上安装的命令**。

```
Published: https://github.com/you/my-plugin

Install it on another machine with:
  dsh plugin --profile desktop add github:you/my-plugin
      (resolves through git; that machine needs git installed)

  dsh plugin --profile desktop add https://codeload.github.com/you/my-plugin/tar.gz/HEAD
      (fetched over HTTPS; no git needed)
```

两条命令都打印，因为哪条能用取决于目标机器：`github:` 形式通过 git 解析，codeload 链接走 HTTPS 直接下载。另外还会给一条**钉住具体提交**的命令，用来安装"确定是这一版"而不是"跟着 HEAD 走"。

## 更新插件

**再跑一次就行。** 第二次发布把新提交的父节点指向分支当前的 HEAD，是一次快进（fast-forward），不需要 `--force`：

```sh
npx dsh-plugin-publish ./my-plugin --yes
```

```
  repo   : exists https://github.com/you/my-plugin
  commit : 3f9a1c2d (12 files)
  topics : dsh-plugin, dsh, deepseek-harness, cordis
```

上传采用"整个目录树即仓库内容"的语义：**本地删掉的文件，远端也会删掉**。所以发布即镜像，不会留下你早已删除的旧文件。

仓库的 description 也会跟着 `package.json` 更新 —— 改了描述再发一次就会同步到仓库页面。

## 它校验什么，为什么

每一项检查的存在，都是因为 DSH 加载器会因此失败，而且失败点往往是静默或令人困惑的：

| 检查 | 没有它会怎样 |
| --- | --- |
| 声明了 `dsh.bundle` | `dsh plugin add` 根本无法安装这个包 |
| patch 文件真实存在 | 组合包层没有东西可应用 |
| patch 行的 `name` 与包名一致 | 模块永远找不到 |
| 浏览器半注册的 `id` 与包名一致 | **浏览器半永远不加载，且没有任何报错** |
| 没有疑似凭据的文件 | 推到公开仓库的 token，推送那一刻就已泄露 |

最后两条最危险：插件看起来装好了，就是什么都不做。以上全部在**任何网络请求之前**运行，所以一个坏掉的 manifest 不可能把仓库发布到一半。

> 关于 `id` 和 `name`：patch 行的 `id` 是**行标识**，`name` 才是**要加载的模块**，两者语义不同、可以不同。本工具因此比对 `name`，不是 `id`。

## 安装

作为 DSH 插件安装 —— 在 harness 内增加 `/publish-plugin` 命令：

```sh
dsh plugin --profile desktop add github:Gty2408/dsh-plugin-publish
```

然后在任意会话里：

```
/publish-plugin                    # 校验工作区里的插件
/publish-plugin --push             # 校验后发布
/publish-plugin ./my-plugin --push --repo custom-name
```

token 从 `~/.dsh/.github-token`（一个带 `repo` 权限的 classic token）或插件的 `token` 配置读取。

作为独立 CLI，供 harness 之外使用：

```sh
npx dsh-plugin-publish --help
```

## 两种认证方式

| 方式 | 何时用 |
| --- | --- |
| **设备码流程**（默认） | 交互式。打印一个短码，你在浏览器里授权。无需粘贴 token。 |
| **`--token`** | 非交互，或 `github.com` 不通但 `api.github.com` 可用时。 |

设备码流程访问 `github.com`，而 API 调用访问 `api.github.com`。这两个域名的可达性可能不同 —— 在某网络上实测，`api.github.com` 约 185 ms 就响应，而 `github.com` 连接 22 秒后失败 —— 这就是保留 token 这条路的原因。

## 安全设计

- **任何网络使用之前先校验。** manifest 有问题就在本地中止。
- **token 会从每一条消息里擦除。** API 报错常会回显请求；`scrubSecrets` 会移除 classic 与 fine-grained 两种 token 形状，以及 URL 里夹带的 token，然后才显示或记录。
- **绝不发布凭据。** 命中凭据特征的文件会在上传前被报出来。
- **绝不强推**，除非显式给出 `--force`。
- **报告部分进度。** 中途失败会留下一个仓库，所以输出会说明哪些步骤已经发生。
- **不丢你的 topic。** GitHub 的 topic 接口是整体替换，本工具先读现有列表再合并，因此你手工设置过的 topic 不会被静默抹掉。
- **遵循 `.gitignore`。** 构建产物、编辑器状态、本地数据不会因为恰好放在源码旁边就被推到公开仓库。
- **吊销提醒。** 每次运行结束都会指向吊销页面。

## 测试

```sh
node test/run.mjs
```

测试套件是**密闭的**：无网络、无凭据、无账号。推送路径的每个分支 —— 空仓库的播种、blob/tree/commit/ref 序列、409 情形、错误传播、重试行为、topic 合并、`.gitignore` 匹配 —— 都跑在一个说同样 REST 接口的假 GitHub 上。`hermetic.test.mjs` 通过扫描其他测试文件来强制这一性质：不允许读凭据，不允许未 mock 的调用。

这是刻意的。早期版本每次运行都会发布到真实仓库来证明流程可用；由于 `repo` 权限不能删仓库，每次运行都留下一个用户必须手工清理的产物。一个会写真实账号的测试不是测试，是带了断言的副作用。

### 验证真实网络路径

真实网络路径由一个**不属于测试套件**的脚本单独、刻意地检查一次：

```sh
node test/live-verify.mjs --i-know-this-creates-a-repo
```

没有那个标志它会拒绝运行，并复用同一个固定仓库名，所以反复运行不会累积产物；结束时打印清理链接。

## 已知限制

- `repo` 权限**不能删除仓库** —— 那需要 `delete_repo`。所以本工具从不提供清理功能，删除是手工步骤。
- 本工具只发布到 GitHub。**它不投稿插件市场**，也不发布到 npm。
- `--force` 会覆盖分支。不带它时，已有提交的分支不会被强行改写（GitHub 会以非快进拒绝，本工具会报告该错误）。
- API 传输单文件上限 40 MB（本工具保守设的上限；GitHub 自身对 inline blob 的上限是 100 MB）。超限时会明确指出是哪个文件，并建议改用 release asset 或加进 `.gitignore`。

## 环境要求

- Node.js 20+
- 一个 GitHub 账号

## 许可证

MIT