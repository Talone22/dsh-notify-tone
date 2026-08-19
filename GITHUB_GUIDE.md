# 发布教程：上传 GitHub + 发布 npm

本文以 dsh-notify-tone 插件为例，一步步说明如何把插件项目发布到 GitHub，
并发布到 npm，让其他用户用一条 `dsh plugin` 命令就能安装。

---

## 第一步：配置 git 身份（只需一次）

打开终端（PowerShell），执行（把邮箱换成你的）：

```bash
git config --global user.name "Talone22"
git config --global user.email "你的邮箱@example.com"
```

> 身份会写入你的提交历史。GitHub 会用它关联你的账号。

## 第二步：提交代码（仓库已初始化，文件已暂存）

```bash
cd D:\dsh_home\问题\dsh-notify-tone
git commit -m "feat: dsh 提示音插件（多音色 + 悬浮设置菜单）"
```

- `git status` 查看状态；`git log --oneline` 查看提交记录。

## 第三步：在 GitHub 网页创建仓库

1. 打开 https://github.com/new （需已登录 GitHub）
2. **Repository name** 填：`dsh-notify-tone`
3. 可见性选 **Public**
4. 不要勾选 "Add a README / .gitignore / license"（本地都已准备好，避免冲突）
5. 点 **Create repository**

创建完成后页面会显示推送命令，直接用它（见第四步）。

## 第四步：关联本地仓库并推送

```bash
cd D:\dsh_home\问题\dsh-notify-tone
git remote add origin https://github.com/Talone22/dsh-notify-tone.git
git push -u origin main
```

- 第一次 push 会弹出 GitHub 登录窗口（Windows 的 Git Credential Manager），
  按提示用浏览器登录即可，之后自动记住。
- 成功后打开 `https://github.com/Talone22/dsh-notify-tone` 就能看到代码了。

> 以后改代码：`git add -A` → `git commit -m "说明"` → `git push`。

## 第五步：发布到 npm（让其他人能一键安装）

**先注册 npm 账号**：打开 https://www.npmjs.com/signup 注册。

然后在终端登录并发布：

```bash
# 1. 登录（按提示输入用户名/密码/邮箱验证码）
npm login

# 2. 发布（在插件目录执行）
cd D:\dsh_home\问题\dsh-notify-tone
npm publish
```

> - 包内容由 package.json 的 `files` 字段控制（lib、cordis.patch.yml、README、LICENSE），
>   测试脚本不会被打包进去。
> - 包名 `dsh-notify-tone` 已在 npm 验证可用（发布前请确认仍未被占用：
>   `npm view dsh-notify-tone`，无结果即可用）。
> - 发布后验证：`npm view dsh-notify-tone` 能看到你的包信息。

**其他人安装你的插件**（任意装了 dsh 的机器）：

```bash
dsh plugin --profile web add dsh-notify-tone
```

然后重启 dsh 即生效。dsh 会自动识别包里的 `dsh.bundle.patch` 声明，
把插件加入 profile 的 bundles 层并加载。

**发布新版本**（改代码后）：在 package.json 里改大 `version`（语义化版本，
如 0.1.0 → 0.1.1），再 `npm publish`。用户更新：

```bash
dsh plugin --profile web update dsh-notify-tone
```

## 不发布 npm 的替代安装方式（GitHub 直装 / 本地链接）

```bash
# 从 GitHub 直接安装（走 git 依赖，仓库里需有可用的 package.json）
dsh plugin --profile web add git+https://github.com/Talone22/dsh-notify-tone.git

# 本地开发调试
dsh plugin --profile web add link:D:\dsh_home\问题\dsh-notify-tone
```

## 常见问题

- **push 提示认证失败**：用 HTTPS + Git Credential Manager 浏览器登录；
  或改用 SSH（配置 `~/.ssh` 密钥后在 GitHub 添加公钥，remote 换成
  `git@github.com:Talone22/dsh-notify-tone.git`）。
- **npm publish 提示名字被占用**：换一个包名（改 package.json 的 `name`，
  同时改 `lib/client.js` 里 `window.__ModuleLoader__.load({ id: "新名字" })`
  和 `cordis.patch.yml` 里的 name，保持三者一致）。
- **发布后安装不生效**：确认包内 `cordis.patch.yml` 存在，且 package.json
  有 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。
