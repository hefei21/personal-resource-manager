# PR Manager PC Worker

阶段 5 的 Windows PC 执行节点。Worker 只主动连接 NAS，不监听端口，不保存 Owner 密码，
也不能读取任意 NAS 路径。当前只实现模型无关的 `content.inspect` v1 探针。

## 要求

- Windows 11 与 Node.js 22–24；
- NAS 后端已升级到包含阶段 5 协议的不可变镜像；
- 正式局域网连接使用受信 HTTPS；纯 HTTP 只允许 loopback，或在隔离验收时显式设置
  `PC_WORKER_ALLOW_INSECURE_HTTP=true`；
- Owner 已在 NAS API/UI 创建 10 分钟内有效的一次性配对码。

## 首次配对

在本目录打开 PowerShell，只执行一次：

```powershell
$env:PC_WORKER_NAS_BASE_URL = 'https://nas.example.local'
$env:PC_WORKER_ENROLLMENT_TOKEN = '<一次性配对码>'
node .\src\index.js --once
Remove-Item Env:PC_WORKER_ENROLLMENT_TOKEN
```

凭据写入 `%LOCALAPPDATA%\PRManagerWorker\state.json`。文件不放在仓库中；服务端和本地日志
均不打印 Token。若刷新凭据被重放，NAS 会吊销该 Worker，需要 Owner 重新配对。

## 隐藏自启动

首次配对成功后，以当前用户安装登录触发的隐藏计划任务：

```powershell
.\scripts\install-scheduled-task.ps1 -NasBaseUrl 'https://nas.example.local'
```

任务以当前普通用户、`Interactive` 登录类型运行，不弹出控制台；这是因为后续 LM Studio
能力属于当前桌面用户。它不是“无人登录也运行”的 Windows 服务：PC 重启后需该用户登录，
Worker 才会启动。错过登录触发时使用 `StartWhenAvailable` 补跑，但不会唤醒睡眠中的 PC。

卸载只删除计划任务，不删除凭据状态：

```powershell
.\scripts\uninstall-scheduled-task.ps1
```

Owner 在 NAS 端吊销 Worker 后，现有凭据立即失效；已领取任务由 NAS 在租约过期后恢复。

## 当前能力与后续模型

Worker 使用 `nvidia-smi` 上报 GPU/显存，并用 `lms ps --json` 上报当前已加载模型。两个命令
失败时均降级为空能力快照，不影响探针任务。Embedding、Reranker、OCR 和 LLM 会作为新的
处理器版本加入，不改变配对、租约、受控下载和结果提交协议。
