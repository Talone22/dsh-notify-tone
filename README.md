# dsh-notify-tone（声音 + 视觉 + 系统通知提醒插件）

dsh web GUI 的提醒插件：

- **需要操作提醒**：AI 执行任务中遇到需要用户授权或选择时（沙箱权限授权弹窗、`ask_user_question` 提问、计划审批等），同时触发提示音、屏幕光效与系统通知，提醒你回到窗口处理。
- **回答完成提醒**：AI 每轮回答结束时，同样触发三重提醒，提醒你回复已生成。

## 特性

- **声音提醒**：Web Audio 合成（基频 + 泛音，无音频文件），内置 **5 套音色**——经典双音、清脆叮咚（叮——）、明亮三连、柔和轻音、**尖锐警示**（方波高频，最醒目），点击即可试听并选中。
- **视觉提醒**：屏幕四周大圆弧光带 + 泡泡式弹性向内挤压脉冲（柔和、不遮挡、不拦截鼠标）；「需要操作」「回答完成」**各自独立配色**（8 种预设 + 🌈 自定义色相），选色即时预览。
- **系统通知**：触发时弹出**操作系统级桌面通知**（含系统声音），**在浏览器外、其他窗口、浏览器最小化时也能看到**；点击通知可跳回 dsh 窗口。首次使用需在浏览器中授权（打开开关时自动请求）。
- **分别开关**：总开关、声音开关、视觉开关、系统通知开关**四者独立**，互不影响。
- **持久生效**：所有开关、音色、颜色都存 `localStorage`，重启后保持；旧版设置（`dsh.notify-sound.*`）自动迁移。
- **悬浮设置菜单**：鼠标悬停页面右下角 🔔 按钮自动弹出：总开关、声音/视觉/系统通知分别开关、音色选择（点击试听）、颜色选择（展开面板，点击预览）。
- **不侵入**：不改动 dsh 任何原有组件与第三方插件；插件只做「监听会话状态 + 发声 + 视觉层 + 系统通知 + 一个悬浮按钮/菜单」。  
![alt text](/image_1.jpg)  
![alt text](/image_3.jpg)  
![alt text](/image_2.jpg)

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
- 收不到系统通知：① 打开 🔔 菜单「系统通知」开关并允许浏览器的授权询问；② 若显示"权限已被禁用"，需到浏览器站点设置（地址栏左侧锁图标 → 网站设置）中把「通知」改为允许；③ Windows 还需确认系统"通知和操作"未对浏览器静音。
- 若之后运行过 `pnpm install` 导致手动放置的包被清理，请重新复制本目录到 `~/.dsh/profiles/web/node_modules/`（或在 profile 目录执行 `dsh plugin --profile web add link:<本目录绝对路径>`）。
