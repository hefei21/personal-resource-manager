# PR Manager PC Worker

Windows PC 执行节点。Worker 只主动连接 NAS，不监听端口，不保存 Owner 密码，也不能读取任意
NAS 路径。当前支持受租约约束的内容检查、PDF/DOCX/EPUB 结构化文本提取、本地 Embedding、
查询向量和证据约束回答；未完整配置的模型能力不会上报。

## 要求

- Windows 11 与 Node.js 22–24；
- 在本目录执行 `npm ci` 安装锁定依赖；
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

## 模型能力与自动上下线

Worker 使用 `nvidia-smi` 上报 GPU/显存，并用 `lms ps --json` 上报当前已加载模型。两个命令
失败时均降级为空能力快照，不影响 CPU 提取任务。`rag.content.extract@v1` 始终可用，并在
Worker 内校验授权流的字节数与 SHA-256；PDF/DOCX/EPUB 派生制品以大小受限、哈希绑定的章节
manifest 返回。Embedding 与回答只在端点、模型版本和限制完整配置时上报，继续复用配对、租约、
受控下载和结果提交协议。模型端点只允许 HTTPS，loopback 调试可使用 HTTP。

Qwen 回答与 Nomic Embedding 由当前桌面用户的 LM Studio 承载；BGE v2-m3 Reranker 由独立、
仅绑定 loopback 的 Hugging Face TEI 服务承载。Worker 不负责自动加载或卸载任何模型，也不会调用
`/v1/models` 或发送探测推理来触发 JIT 加载。它每隔约 15 秒读取一次 `lms ps --json` 的
“当前已加载”快照，并在领取任务、调用 NAS `start` 前再次强制读取：手动 eject 回答模型后只
撤销回答能力，手动 eject Embedding 后只撤销向量能力；TEI readiness 必须从 `/info` 确认实际
`model_type.reranker`（或等价的 `"reranker"` 值）、固定 served/model identity 和 revision，并验证
D 盘本地固定 manifest；
`/health` 仅作诊断，不能单独使能力上线，也不会调用 `/rerank`。停止 TEI 时只撤销 Reranker
能力；CPU 文本提取、NAS 任务队列、FTS 和资源管理继续工作。已领取的 GPU 任务失败后按受限重试
语义回到 NAS，不会丢失。重新加载同一精确 model key 后，能力通常在下一次 readiness 刷新时恢复，
无需重启 Worker。连续不可用时刷新退避到最多 60 秒，因此最坏恢复时间约 60 秒。

阶段 6C 已验证的本地回答模型是 LM Studio 中的
`qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k`。阶段 6C 采用的 Embedding 模型是
`text-embedding-nomic-embed-text-v1.5`（Nomic v1.5 Q4_K_M，768 维，2048 context）。
可选 Reranker 是固定 revision 的 `BAAI/bge-reranker-v2-m3`，只重排已授权的 Hybrid top-10；
离线、超时或结果身份不符时保留原 Hybrid 顺序。
关键环境变量为：

```powershell
$env:PC_WORKER_ANSWER_BASE_URL = 'http://127.0.0.1:1234'
$env:PC_WORKER_ANSWER_PROVIDER = 'lm-studio'
$env:PC_WORKER_ANSWER_MODEL_ID = 'qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k'
$env:PC_WORKER_ANSWER_MODEL_REVISION = 'Q6_K'
$env:PC_WORKER_ANSWER_CONTEXT_LIMIT = '32768'
$env:PC_WORKER_ANSWER_MAX_OUTPUT_BYTES = '16384'
$env:PC_WORKER_EMBEDDINGS_BASE_URL = 'http://127.0.0.1:1234'
$env:PC_WORKER_EMBEDDINGS_PROVIDER = 'lm-studio'
$env:PC_WORKER_EMBEDDINGS_MODEL_ID = 'text-embedding-nomic-embed-text-v1.5'
$env:PC_WORKER_EMBEDDINGS_MODEL_REVISION = 'gguf-sha256-d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac'
$env:PC_WORKER_EMBEDDINGS_DIMENSIONS = '768'
$env:PC_WORKER_EMBEDDINGS_INPUT_LIMIT = '2048'
$env:PC_WORKER_EMBEDDINGS_CONFIG_HASH = '7d93077b98e4a05746f0de951f9156d9671de74a446a4312b2baaa092eabbdad'
$env:PC_WORKER_RERANKER_BASE_URL = 'http://127.0.0.1:18081'
$env:PC_WORKER_RERANKER_PROVIDER = 'hugging-face-tei'
$env:PC_WORKER_RERANKER_MODEL_ID = 'BAAI/bge-reranker-v2-m3'
$env:PC_WORKER_RERANKER_MODEL_REVISION = '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e'
$env:PC_WORKER_RERANKER_DIMENSIONS = '1'
$env:PC_WORKER_RERANKER_INPUT_LIMIT = '512'
$env:PC_WORKER_RERANKER_CONFIG_HASH = '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a'
$env:PC_WORKER_RERANKER_TIMEOUT_MS = '15000'
$env:PC_WORKER_MODEL_READINESS_INTERVAL_MS = '15000'
$env:PC_WORKER_MODEL_READINESS_MAX_BACKOFF_MS = '60000'
```

上面的 `$env:` 只对当前 PowerShell 有效。隐藏计划任务要长期使用这些值时，应在当前用户级环境
变量中保存，并重新启动计划任务使其继承新环境。不要把配置写进仓库；可在 PowerShell 中逐项执行：

```powershell
[Environment]::SetEnvironmentVariable('PC_WORKER_ANSWER_BASE_URL', 'http://127.0.0.1:1234', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_ANSWER_PROVIDER', 'lm-studio', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_ANSWER_MODEL_ID', 'qwen3.5-9b-uncensored-hauhaucs-aggressive@q6_k', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_ANSWER_MODEL_REVISION', 'Q6_K', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_ANSWER_CONTEXT_LIMIT', '32768', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_ANSWER_MAX_OUTPUT_BYTES', '16384', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_BASE_URL', 'http://127.0.0.1:1234', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_PROVIDER', 'lm-studio', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_MODEL_ID', 'text-embedding-nomic-embed-text-v1.5', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_MODEL_REVISION', 'gguf-sha256-d4e388894e09cf3816e8b0896d81d265b55e7a9fff9ab03fe8bf4ef5e11295ac', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_DIMENSIONS', '768', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_INPUT_LIMIT', '2048', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_EMBEDDINGS_CONFIG_HASH', '7d93077b98e4a05746f0de951f9156d9671de74a446a4312b2baaa092eabbdad', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_BASE_URL', 'http://127.0.0.1:18081', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_PROVIDER', 'hugging-face-tei', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_MODEL_ID', 'BAAI/bge-reranker-v2-m3', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_MODEL_REVISION', '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_DIMENSIONS', '1', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_INPUT_LIMIT', '512', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_CONFIG_HASH', '5d456e4278f50b53df3cd788abcda2fccb91c65104b1f5063fd12eb741b2440a', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_RERANKER_TIMEOUT_MS', '15000', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_MODEL_READINESS_INTERVAL_MS', '15000', 'User')
[Environment]::SetEnvironmentVariable('PC_WORKER_MODEL_READINESS_MAX_BACKOFF_MS', '60000', 'User')
```

模型与 Reranker 运行资产统一在 D 盘：Nomic 为 `D:\PRManagerAI\models\nomic`，BGE 为
`D:\PRManagerAI\models\bge-reranker-v2-m3`，TEI cache/runtime/log 分别位于
`D:\PRManagerAI\cache\huggingface`、`D:\PRManagerAI\runtime\tei`、
`D:\PRManagerAI\logs\bge-reranker`。现有 Qwen 不移动。

LM Studio API Server 仍需由当前用户启动；Worker 通过
`PC_WORKER_ANSWER_BASE_URL` / `PC_WORKER_EMBEDDINGS_BASE_URL` 读取实际端口，以上 `1234` 只是示例，
不是源码固定值。Windows 若返回 `listen EACCES`，先用
`netsh interface ipv4 show excludedportrange protocol=tcp` 检查系统排除端口段，再选择一个未排除、
未占用的端口并同步更新两个 Base URL；不要为单台机器把仓库默认示例整体改成专用端口。

TEI 需要 Docker/NVIDIA
Container Toolkit；准备、启动、停止和导出日志分别使用 `scripts/reranker-prepare-model.ps1`、
`scripts/reranker-start.ps1`、`scripts/reranker-stop.ps1`、`scripts/reranker-logs.ps1`。准备脚本只
接受固定 revision 的六个模型文件及固定 SHA-256/长度，已有 manifest 不会被重新生成；启动脚本
再次核对文件并等待 `/info` 通过后才报告成功，失败会停止该 TEI 容器。普通 Worker 启动不会自动
启动 TEI。系统只观察加载状态，不替 Owner 决定何时占用或释放显存；若 LM Studio 或其他桌面端
提供 JIT/自动加载开关，应保持关闭；Worker 本身只做任务前快照和 fail-closed 检查，不发送加载
命令。玩游戏前可手动 eject LM Studio 模型并停止 TEI，结束后按需重新加载/启动，Worker 无需重启。

任务不能覆盖本地模型或端点；回答必须通过严格 JSON Schema，并且引用只能来自本次证据集。
