# dsh-notify-tone（提示音插件）

dsh web GUI 的提示音插件：

- **需要操作提醒**：AI 执行任务中遇到需要用户授权或选择时（沙箱权限授权弹窗、`ask_user_question` 提问、计划审批等），播放急促提示音，提醒你回到窗口处理。
- **回答完成提醒**：AI 每轮回答结束时，播放提示音，提醒你回复已生成。

## 特性

- **零依赖**：只用浏览器 Web Audio API 合成提示音（基频 + 泛音，声音更明显），无需任何音频文件。
- **持久生效**：开关状态与所选提示音都保存在 `localStorage`，刷新页面、重启后依然保持。
- **悬浮设置菜单**：鼠标悬停页面右下角的 🔔 按钮，自动弹出二级菜单：
  - **功能开关**：一键开/关（打开时播放当前音色试听反馈）；
  - **提示音选择**：内置 4 套提示音——经典双音、清脆叮咚（叮——）、明亮三连、柔和轻音，点击选项即选中生效（带 ✓ 标记）；
  - **试听预览**：每套音色右侧有「▶ 试听」按钮，点击可先听完整效果（需要操作 + 回答完成连播），再决定是否应用。
- **不侵入**：不改动 dsh 任何原有组件与第三方插件；插件只做「监听会话状态 + 发声 + 一个悬浮按钮/菜单」。

## 安装

### 方式一：npm 安装（已发布到npm）

```bash
dsh plugin --profile web add dsh-notify-tone
```

### 方式二：从 GitHub 直接安装

```bash
dsh plugin --profile web add git+https://github.com/<你的GitHub用户名>/dsh-notify-tone.git
```

### 方式三：本地链接（开发调试）

```bash
dsh plugin --profile web add link:/绝对路径/dsh-notify-tone
```

安装后**重启 dsh**（完全退出 `dsh web` 进程再启动）即生效。

本机当前以本地目录方式挂载：包位于 `~/.dsh/profiles/web/node_modules/dsh-notify-tone/`，
启用条目在 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- insert:
    - id: notify-tone
      name: 'dsh-notify-tone'
```

## 卸载

- npm/GitHub 方式：`dsh plugin --profile web remove dsh-notify-tone`，重启 dsh。
- 本地目录方式：删除 `cordis.patch.yml` 中的 `notify-tone` 插入行，删除 `node_modules/dsh-notify-tone/` 目录，重启 dsh。

## 故障排查

- 听不到声音：浏览器自动播放策略要求页面至少被点击过一次；点击页面任意位置后再试。
- 若之后运行过 `pnpm install` 导致手动放置的包被清理，请重新复制本目录到 `~/.dsh/profiles/web/node_modules/`（或在 profile 目录执行 `dsh plugin --profile web add link:<本目录绝对路径>`）。
