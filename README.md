# codex-candy-eval · CPR Codex 账号测试

版本 **1.1.0**。在 CPR 管理端选择账号、客户端 Key、模型和推理强度，运行糖果题、模型指纹或画鹈鹕。一个安装包包含插件程序、管理页面、题库及检测器，由 CPR 管理，无需另部署服务。

已在真实 CPR v3.36.0 中验证完整业务、原生管理页、权限、取消、持久化及运行时替换。测试调用本机受控上游，不消费真实账号额度。[验收记录](docs/verification.md)。

项目仓库：[xqy272/codex-candy-eval](https://github.com/xqy272/codex-candy-eval)。

```bash
git clone https://github.com/xqy272/codex-candy-eval.git
cd codex-candy-eval
```

安装包和校验文件从 [Releases](https://github.com/xqy272/codex-candy-eval/releases) 下载；源码不提交构建缓存和临时测试凭据。插件 ID 保持 `cloudops.codex-candy-eval`，已有实例的升级与历史不受项目拆分影响。

## 安装和使用

已验证平台为 Linux x86_64，要求 glibc 2.28+；宿主合同为 CPR v3.36.0、协议 7、management v2。包声明兼容范围 `>=3.36.0, <3.37.0`。

1. 在 CPR 管理端进入“插件管理”，上传 `cloudops.codex-candy-eval-1.1.0-x86_64-unknown-linux-gnu.tar.gz`，核对同名 `.sha256` 文件及插件 ID `cloudops.codex-candy-eval`。
2. 确认来源和完整信任。首次安装会自动创建并启用默认实例，无必填配置。运行状态应为正常。
3. 打开“Codex 账号测试”，选择已启用的客户端 Key 和模型，测试单个账号，或勾选账号后批量测试。Key 仍须有目标账号及模型的使用权限。

| 测试 | 行为 |
|---|---|
| 糖果题 | 保留 Candy Eval 原题，以独立数字 **21** 为通过条件；每账号可运行 1、3、5、10 次，保留原始回答 |
| 指纹检测 | 从随包固定的 36 道配套题中无放回抽三题；逐题执行和保存，三份完整回答后由 LM Detector Rust SDK 离线评分 |
| 画鹈鹕 | 生成 HTML/SVG/CSS，保留原文并提取 SVG 图片预览，不自动评判绘画质量 |

测试消耗所选账号额度。页面串行执行，每次只运行一道题；单次模型调用最多 150 秒，管理预算 170 秒，早于 CPR 页面 180 秒超时。指纹三题使用同一轮 ID 和不同步骤，进度及结果逐题写入宿主私有状态。

宿主管理桥有 180 秒单请求限制，公开模型回调必须依附父调用；本版本不提供脱离父调用的十分钟后台模型任务。超过当前限制的高强度回答可能被中断并记为超时。

点击“停止”会取消当前调用并停止后续题目和批量。页面关闭或运行时被替换后，已完成样本保留；结果不明的执行标记为中断，不自动重放。重复提交已完成的同一轮不会再次调用模型。

每账号每种测试最多 20 条，全局最多 200 条、摘要约 220 KB、详情总量约 15 MB，容量不足时淘汰较旧记录；单份回答上限 48 KiB。摘要与详情分别保存，展开和导出时按需读取；清理和淘汰同步删除相应详情。停用、重启插件进程及兼容版本切换保留历史。历史可按账号和测试类型筛选，点击“清理筛选历史”并确认后删除当前筛选记录；测试期间禁止清理。“JSON 导出”展开可选中复制的筛选记录；保存失败时会提示及时保留结果。删除实例会由 CPR 删除其私有状态。

## 请求语境与统计

默认“Codex 上下文 v1”使用固定来源的 Codex CLI 0.163.0 基础指令、上下文消息和工具声明，按 CPR Responses 合同构造请求；环境使用固定公共路径，不带本机路径。工具执行始终关闭，身份、认证头及上游编码仍由 CPR 决定。这是上下文适配，不宣称与上游 Responses Lite 请求逐字节相同。

“简化请求 v1”保留无工具的简短请求。1.0.0 的记录归入此语境。结果记录保存语境 ID；相同执行 ID 不能换语境重用。较长的 Codex 上下文会增加输入 Token 消耗。

账号行显示当前测试最近结果和时间。糖果“正确/有效”按当前模型、推理强度、语境分组；只计答对和答错，执行失败单列。历史与 JSON 中保留原始回答，糖果固定按独立数字 21 判分。

## 结果含义

糖果判分只匹配独立数字 21，不自动审阅推导。指纹排名和概率只比较参考库中的候选，不证明真实模型身份；样本不足不强行给出排名。参考库将 gpt-6-astra 与 gpt-6.1-sol 合为一个候选。

指纹详情展示模型家族、有效样本数、候选排名及参考库别名映射的一致性；这些不是模型身份证明。Token 用量按宿主实际返回的字段展示。绘图支持放大，原始代码可选中复制。

模型请求通过 `host.model.execute` 显式指定 provider、account ID 和 client Key ID，继续执行 CPR 的授权、账号资格、租约、用量及出口规则。插件不手取账号凭据直连，不改变账号调度或出口。插件不额外重试，宿主仍可能内部重试，记录的 `upstreamAttempts` 保留为未知；`accountId` 为指定目标，实际账号可在 CPR 中按请求 ID 核对。

绘图预览将清洗后的 SVG 作为 data 图片加载，不把生成 HTML 插入管理页的可执行 DOM。CPR 禁止嵌套 iframe；没有 SVG 的纯 HTML/CSS 回答保留原文供查看。

## 构建与验证

需要 Rust 1.99.1、C 编译工具、Node.js 24+，以及从 CPR v3.36.0 源码构建的官方 `cpr-plugin` CLI：

```bash
cargo +1.99.1 install --locked --path /path/to/codex-proxy-rs/backend/apps/plugin-cli --root /path/to/local-tools
export PLUGIN_CLI=/path/to/local-tools/bin/cpr-plugin
python /path/to/codex-candy-eval/scripts/build.py --target x86_64-unknown-linux-gnu
```

脚本从自身路径定位工程，校验固定来源摘要，执行 `npm ci`、页面与 Rust release 构建、官方 CLI 打包及归档独立校验。产物位于 `dist/`。交叉编译须另行配置目标工具链和链接器；安装插件本身不需要 Rust 或 Node.js。

在项目根目录验证源码：

```bash
cargo +1.99.1 fmt --manifest-path backend/Cargo.toml -- --check
cargo +1.99.1 clippy --manifest-path backend/Cargo.toml --all-targets --locked -- -D warnings
cargo +1.99.1 test --manifest-path backend/Cargo.toml --locked
npm --prefix frontend ci
npm --prefix frontend run build
npm --prefix frontend run test:ui
python scripts/verify_sources.py
python scripts/check_package.py dist/cloudops.codex-candy-eval-1.1.0-x86_64-unknown-linux-gnu.tar.gz
```

GitHub Actions 检查模板位于 `ci/github-actions.yml`，覆盖固定来源、Rust 和前端检查。发布时使用的 GitHub 凭据不含 `workflow` 权限，因此模板暂未启用；取得该权限后可将它放入 `.github/workflows/check.yml`。

真实宿主验收脚本、受控上游及启动/清理步骤见 [integration](integration/README.md)。截图：[糖果题](docs/native-candy.png)、[指纹检测](docs/native-fingerprint.png)、[鹈鹕预览](docs/native-pelican.png)、[深色窄屏](docs/native-dark-mobile.png)。

## 来源与许可

本插件采用 [MIT](LICENSE)。92 个固定来源文件的逐项 SHA-256 见 [SOURCES.json](vendor/SOURCES.json)，许可文本见 [licenses](licenses)。Rust 与前端依赖均使用锁文件。

- [CPR SDK v3.35.1](https://github.com/zyycn/codex-proxy-rs/tree/v3.35.1/backend/crates/gateway-plugin/sdk)：Apache-2.0；仅展开 Cargo workspace 元数据并移除开发依赖。
- [LM Fingerpoint Detector](https://github.com/Ikaleio/lm-detector/tree/main/sdk/rust)：vendored Rust SDK 0.2.0，MIT；仅本地加载和离线评分，不调用其在线采样或更新接口。
- [Candy Eval](https://github.com/haowang02/cpa-plugin-codex-candy-eval)：交互、糖果题及配套指纹资源参考。数据固定于上游 `a4ef212df06817e8071acd05f00219f4c9eb2f9a`，built_at 为 `2026-10-27T05:02:50.758637+00:00`。
- [codex-proxy-ui v0.7.0](https://github.com/zyycn/codex-proxy-ui/releases/tag/v0.7.0)：Apache-2.0；Vue 为 MIT，DOMPurify 使用其 Apache-2.0 许可选项。
