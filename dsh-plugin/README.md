# dsh-qianfeiwanyu

千肥万鱼的 **DSH 联动桥插件**。装在 DeepSeek Harness（DSH）里后，它会监听 Agent 的会话状态，经本机回环（127.0.0.1）把状态推给「千肥万鱼」桌面观察台，让鲸鱼娘的表情和台词跟着你干活的状态走：

| Agent 状态 | 她的反应 |
| --- | --- |
| 开始 / 工具执行中 | 认真表情 + 「我在干活啦，稍等一下下～」 |
| 思考 / 等待批准 | 疑惑表情 + 应景台词 |
| 一轮完成 | 欢呼表情 + 白闪 + 「搞定啦！」 |
| 出错 | 受惊表情 + 「哎呀，出错了！」 |

**只做状态联动**：不读写 DSH 的业务数据、不联网、只和本机的千肥万鱼服务（默认端口 18765）通信。千肥万鱼进入「游戏模式」时会自动静默。

## 前置条件

1. 已安装 DSH（桌面版或 Web 版均可，需支持 Bundle 插件，DSH ≥ 0.2.1-rc.2）。
2. 已装好「千肥万鱼」桌面客户端，并且它正在运行（默认监听 127.0.0.1:18765）。

## 安装

在本机 DSH 终端里执行（把路径换成你 clone 后的实际位置）：

```bash
# 开发期：本地路径安装（改完源码重启 DSH 生效）
dsh plugin --profile desktop add ./dsh-plugin

# 或在仓库根目录直接装子目录
dsh plugin --profile desktop add ./千肥万鱼-repo/dsh-plugin
```

如果你用的是 web 档，把 `--profile desktop` 换成 `--profile web`。装完**重启 DSH**，插件随 profile 加载。

> 不确定用哪个 profile？看 `~/.dsh/profiles/` 下有哪些目录；大多数人桌面版是 `desktop`，命令行版是 `web`。

卸载：

```bash
dsh plugin --profile desktop remove dsh-qianfeiwanyu
```

## 验证是否生效

1. 浏览器打开 `http://127.0.0.1:3080/dsh-qianfeiwanyu/status`（DSH 的 Web 服务端口，默认 3080）。
   看到 `{"ok":true,...,"target":"http://127.0.0.1:18765/..."}` 就说明插件活着。
2. 在千肥万鱼里：设置 → 对话 → **DSH 插件联动** → 点「测试接收状态」。
   让 DSH 跑一个任务，再点一次，应能看到 `收到：working` 之类的状态。
3. 插件每次推送也会写一份到 `~/.dsh/qianfeiwanyu-bridge-state.json`，可直接查看最后一次状态。

## 配置

编辑 profile 的 `cordis.patch.yml`，找到 `id: qianfeiwanyu-bridge` 这一段：

```yaml
- insert:
    - id: qianfeiwanyu-bridge
      name: dsh-qianfeiwanyu
      config:
        port: 18765        # 千肥万鱼本地服务端口
        enabled: true      # 总开关
        speak: true        # 是否让观察台念出台词
        minIntervalMs: 1200  # 同一状态最小推送间隔，防刷屏
```

改完重启 DSH。

## 常见问题

- **观察台没反应**：确认千肥万鱼客户端正在运行；确认端口一致；在观察台「设置 → 对话」里勾上「启用联动」。
- **`dsh plugin add` 失败**：确认当前 DSH 版本支持 Bundle 插件；本地路径要用相对或绝对路径指向 `dsh-plugin/` 这个含 `package.json` 的目录。
- **状态路由 404**：DSH 不同版本的 Web 服务端口可能不是 3080，以你实际的 DSH Web 端口为准。

## 许可

MIT。详见 LICENSE。
