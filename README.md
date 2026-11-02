# codex-candy-eval

CPR 原生账号测试插件，版本 **1.2.0**。选择账号后提交检测，关闭页面后由 CPR 的维护回调继续执行；回来查看进度和报告。一个 Linux x86_64 安装包包含程序、管理页和固定检测资源，无需另部署服务。

## 安装与升级

从 [Releases](https://github.com/xqy272/codex-candy-eval/releases) 下载 `cloudops.codex-candy-eval-1.2.0-x86_64-unknown-linux-gnu.tar.gz` 及同名 `.sha256`，在 CPR 插件管理中上传并核对摘要。首次安装后打开“Codex 账号测试”。要求 Linux x86_64、glibc 2.28+；宿主范围声明为 `>=3.36.0, <3.39.0`，实际版本验收见 [验证记录](docs/verification.md)。不声明未来 CPR 版本兼容。

已有用户在**原实例切换版本**，不要删除实例或清空私有状态。插件 ID 保持 `cloudops.codex-candy-eval`。新版新增 `maintenance` 能力，由宿主调用后台任务；按宿主提示检查和信任新清单。升级前结束活动请求并备份应用数据与数据库。

history schema 继续为 2，details 继续为 1，已有 1.1.1/1.1.2 历史原样保留；1.0.0/1.1.0 的 history schema 1 通过正式迁移处理器保留。旧记录明确标注，不补造身份或任务信息，不计入新版统计。旧版活动检测不会自动转为新任务。

新任务使用独立的 tasks、samples、queue 命名空间。需要降回旧版时，停止任务并使用升级前成套备份；旧版不能管理新任务，不承诺跨版本原地降级。

## 使用

1. 选择测试类型、客户端 Key、模型与账号。糖果题可以选择每账号 1、3、5、10 次，各次独立保存。
2. 检查计划请求次数后提交。每个账号的一次检测是一份任务；可以离开页面，任务由宿主串行推进。
3. 在“任务”查看进度、暂停原因并停止或继续。在“历史”阅读报告、导出或删除已结束检测。

| 测试 | 有效结果与含义 |
| --- | --- |
| 糖果题 | 固定原题，以独立数字 **21** 判分；完整回答才记为正确或错误，执行失败不记为答错 |
| 模型指纹 | 从固定配套题库抽三题，要求三份完整且通过原算法数字校验的回答；呈现参考库候选排名，不能证明模型身份 |
| 画鹈鹕 | 辅助查看输出，保留原文并隔离预览 SVG；不自动评判绘画质量或模型身份 |

测试消耗所选账号额度。插件不自动重试、不换账号或出口；宿主可能内部重试，插件不把调用次数当作上游尝试次数。客户端 Key 权限、指定账号的资格、租约、额度、认证与网络出口继续由 CPR 执行。插件不读取账号 OAuth 或直连其上游凭据。

默认使用**简洁语境 v1**。高级设置可选推理强度和固定 Codex 上下文 v1；后者包含较长的 CLI 指令、上下文和工具声明，但工具执行关闭。两种语境独立统计；Codex 上下文不宣称复制完整线上客户端请求。账号最近结果同时匹配测试类型、模型、强度和语境。糖果统计只计算新版保留记录中完成的回答。

## 中断、停止和继续

任务冻结账号身份、Key、模型、强度、语境、题目、算法及资源摘要。普通 OAuth 凭据刷新不会单独判为换号；上游身份变化时暂停。没有稳定上游身份的账号，凭据版本变化也会暂停。

执行前保存意图，收到回答后先保存样本，再更新进度与评分。进程恢复后，已保存样本继续处理；只有执行意图、没有可靠结果的请求标记“结果不确定”，不自动重发。用户明确继续后才补缺失或无效样本，复用原题和已有有效样本，单任务最多九次尝试。

模型调用最多 150 秒；每轮维护声明 180 秒预算，剩余不足完整请求及收尾窗口时保持排队。维护回调的调度间隔由宿主决定，可能需要等待约 30 秒。插件必须保持启用，停用或宿主停止期间不会执行。

停止会关闭活动受管流并保留已有样本，已停止任务不能继续；需要再测时新建检测。超时、缺失成功终态、拒答或无效数字样本不作为完整指纹证据。容量类错误不等于已证明真实物理容量不足，报告保留有界诊断和已取得的请求 ID。

## 报告与存储

报告先展示结果、样本数量和候选排名，题目、原始回答与请求诊断折叠显示。导出包含冻结计划、资源摘要、身份快照、采样规则和所有尝试；受宿主下载沙箱限制时仍可从文本框选中复制 JSON。

最多 16 份未结束任务；最多保留 100 份新版任务及约 12 MB 样本，优先清理旧的已结束任务，保护排队、执行和暂停任务。每份回答正文最多 48 KiB，样本分别保存和读取。删除有持久清理标记，中断后继续清理。旧版 history/details 的既有保留边界不变。

指纹固定使用 LM Fingerprint Detector Rust SDK 0.2.0 和配套数据。概率仅在库内候选间比较，不把糖果、指纹和绘图合并成健康分；没有定时检测、自动禁用或自动移组。

## 构建与验证

需要 Rust 1.99.1、C 工具链、Node.js 24+ 与 CPR 官方 `cpr-plugin` 打包 CLI。

```bash
git clone https://github.com/xqy272/codex-candy-eval.git
cd codex-candy-eval
cargo +1.99.1 fmt --manifest-path backend/Cargo.toml -- --check
cargo +1.99.1 clippy --manifest-path backend/Cargo.toml --all-targets --locked -- -D warnings
cargo +1.99.1 test --manifest-path backend/Cargo.toml --locked
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend run test:ui
python scripts/verify_sources.py
export PLUGIN_CLI=/path/to/cpr-plugin
python scripts/build.py --target x86_64-unknown-linux-gnu
```

脚本从自身路径定位工程，使用锁文件、验证固定资源，再通过官方 CLI 打包并独立检查。交叉编译需配置目标工具链与链接器。安装包位于 dist，不进入 Git。

真实宿主、受控上游和页面测试见 [integration](integration/README.md)，持久化与恢复规则见 [架构说明](docs/architecture.md)，验证范围和边界见 [验收记录](docs/verification.md)。CI 模板在 ci/github-actions.yml；当前发布凭据没有 workflow 权限，模板尚未启用。

## 来源与许可

本项目 [MIT](LICENSE)。92 个固定来源文件及 SHA-256 见 [vendor/SOURCES.json](vendor/SOURCES.json)，许可文本见 licenses。题目与检测器没有在本版静默更新。

- gateway-plugin-sdk：CPR v3.35.1 的公开 SDK，Apache-2.0；展开 workspace 元数据并移除开发依赖。使用协议 7、management v2、maintenance v1，兼容性以真实宿主测试为准。
- LM Fingerprint Detector：vendored Rust SDK 0.2.0，MIT，仅本地加载和评分。
- Candy Eval：原题和配套检测资源固定在 a4ef212df06817e8071acd05f00219f4c9eb2f9a；数据 built_at 为 2026-10-27T05:02:50.758637+00:00。
- codex-proxy-ui v0.7.0：Apache-2.0；Vue 为 MIT；DOMPurify 选用 Apache-2.0。页面有主题变量回退，不依赖旧组件的布局默认值。
