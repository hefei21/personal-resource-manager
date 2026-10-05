# 独立 Qwen 重排候选运行时

这是默认关闭的可选运行时，不是 LM Studio 模型，也不替换回答模型。Worker 通过认证的
本机 HTTP 接口使用它；运行时不访问 NAS、不下载模型、不持有 Worker/NAS 凭据。
原 BGE/TEI 配置仍独立保留。关闭此进程后检索回退原 Hybrid，不影响基础全文检索。

## 安装与启动

使用独立 Python 虚拟环境，不借用 ComfyUI 或系统环境。本候选已在 Windows RTX 5080、
Python 3.14、PyTorch 2.13.0+cu130、Transformers 5.14.1 下执行真实推理。
先从官方 PyTorch cu130 索引安装匹配 Python/操作系统的 CUDA wheel，再在该环境中执行
`python -m pip install -r requirements.txt`。CPU torch 不满足启动条件。

模型文件必须来自 `profile.json` 指定的 revision，四个文件都按 SHA-256 验证；模型路径
由操作者提供，不使用在线自动下载或 remote code。权重、虚拟环境和凭据不放入 Git。

在独立进程环境设置随机生成、至少 32 位的 `PC_WORKER_RERANKER_API_KEY`，然后显式启动：

```powershell
python -B runtime.py --model-dir '<已校验模型目录>' --port 19091
```

只监听 `127.0.0.1`；禁止端口转发、公网暴露和浏览器跨源访问。不自动创建计划任务。
Worker 使用相同 API key，并显式设置 `PC_WORKER_RERANKER_MODEL_ID=Qwen/Qwen3-Reranker-0.6B`
和 `PC_WORKER_RERANKER_BASE_URL=http://127.0.0.1:19091`。其余模型身份由固定 profile 派生；
若显式提供不匹配身份，Worker 拒绝启动该配置。服务端仍需独立的默认关闭配置，不能仅凭
Worker 就启用生产重排。后端六字段身份必须与 Worker 完全一致。

## 运行边界

- `/info` 必须返回完整固定模型身份，`/health` 不能单独证明模型匹配；两者均需认证。
- 串行处理，每请求最多 50 条、总请求体最多 2 MiB、每对最多 2048 token、推理批量 8。
- 固定使用 PyTorch SDPA，并按完整输入长度稳定分批以减少 padding；返回分数恢复为请求原顺序。
  注意力实现与分批规则进入配置 hash，旧 eager 身份不可复用。后端、Worker 与运行时须配套升级；
  显式配置旧 hash 时需更新，混用版本将拒绝身份并回退基础检索，不自动兼容旧结果。
- 超长输入整请求拒绝，不截掉证据；任何推理/身份/网络失败由上游 fail-open。
- Worker 的超时/取消会结束等待，但不会抢占已进入 CUDA 的当前推理；此服务不承诺硬实时
  取消。请求串行且有上界，不能据此宣称已通过多请求拥塞或三模型并发验收。
- 支持 50 条是协议容量，启动服务不会自动扩大正式查询的候选池。隔离路由可显式设置
  `rerankerConfig.expandedCandidatePool=true`：只对绑定资源的 Qwen 查询保留融合前 35 条，
  再用未入选向量候选补足至 50，重排前不抑制边界重叠；最终种子/上下文预算不变。
  普通 Hybrid、全局查询和 BGE 不走该路径。它不是 RAG 总质量门通过或生产开启授权。
- Ctrl+C 停止手动启动的服务；不开启自启动，也不自动加载/卸载其他模型。

无需模型的协议测试：`python -B -m unittest discover -s . -p "test_*.py"`。
真实 GPU、与回答模型共驻以及端到端检索质量必须另行验证，不能用这些测试替代。
