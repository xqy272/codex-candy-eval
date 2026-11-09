# 1.4.3 Ciallo 单词请求与紧凑历史行验收

沿用下节的官方 CPR 3.43.1 / 3.44.0 隔离环境。准备发布的 1.4.2 和最终 1.4.3 归档，按顺序执行：

```bash
python3 integration/native_client.py --baseline dist/cloudops.codex-candy-eval-1.4.2-x86_64-unknown-linux-gnu.tar.gz
python3 integration/ui-fixes-native.py --version 1.4.3 seed
python3 integration/ui-fixes-native.py --version 1.4.3 upgrade
python3 integration/ui-fixes-native.py --version 1.4.3 business 3.43.1
node integration/result-report-browser.mjs 3.43.1 1.4.3
python3 integration/ui-fixes-native.py --version 1.4.3 switch
python3 integration/ui-fixes-native.py --version 1.4.3 business 3.44.0
node integration/result-report-browser.mjs 3.44.0 1.4.3
```

业务在每版宿主额外保存两个未完整结束的 Ciallo，核对片段可读但状态仍暂停。浏览器复用隔离数据验证分栏和旧功能，再从 UI 提交六账号 Ciallo。按新批次 ID 等待六个持久任务完成，受控账本必须恰好新增六条、每个固定账号一次，输入只有 `ciallo`。检查各账号外部摘要与执行状态、六账号历史行只占一个入口、长邮箱搜索和结果直达、窄屏、原入口焦点及刷新恢复；这些查看动作不增加请求。证据保存在 `.runtime/integration/ui143-*`，按下节停止及清理临时环境。

---

# 1.4.2 批次时间、检测报告与真实滚动验收

按 1.4.1 小节启动同样的全新临时宿主；准备已发布的 1.4.1 和最终 1.4.2 安装包。逐条运行，业务、浏览器和宿主切换不并行：

```bash
python3 integration/native_client.py --baseline dist/cloudops.codex-candy-eval-1.4.1-x86_64-unknown-linux-gnu.tar.gz
python3 integration/ui-fixes-native.py --version 1.4.2 seed
python3 integration/ui-fixes-native.py --version 1.4.2 upgrade
python3 integration/ui-fixes-native.py --version 1.4.2 business 3.43.1
node integration/result-report-browser.mjs 3.43.1
python3 integration/ui-fixes-native.py --version 1.4.2 switch
python3 integration/ui-fixes-native.py --version 1.4.2 business 3.44.0
node integration/result-report-browser.mjs 3.44.0
```

验收使用同实例的旧批次与新受控批次。浏览器读取确切批次/任务核对日期及字重，验证真实宿主滚动与缩放时遮罩覆盖和页脚点击，检查历史直达、账号切换、两步返回、Markdown/原文、请求用量及两种窄屏。UI 验收仅查看已有结果，账本不得新增请求。受控报告和截图写入 `.runtime/integration/ui142-*`。按下节流程清理，只保留脱敏证据。

---

# 1.4.1 原生 UI 修复与 CPR 3.44.0 验收

仅使用临时本机 CPR、数据库和受控上游。准备已发布 1.4.0 与最终 1.4.1 归档、核验过的官方 3.43.1/3.44.0 发行目录；run_host.py 以 3.43.1 启动，并用 --matrix-cpr-dir 注册 3.44.0 为唯一目标。沿用下方数据库工具参数，不连接生产或真实模型。

按顺序运行，每条成功结束后再运行下一条，不并行业务与浏览器检查：

```bash
python3 integration/native_client.py --baseline dist/cloudops.codex-candy-eval-1.4.0-x86_64-unknown-linux-gnu.tar.gz
python3 integration/ui-fixes-native.py seed
python3 integration/ui-fixes-native.py upgrade
python3 integration/ui-fixes-native.py business 3.43.1
node integration/ui-fixes-browser.mjs 3.43.1
python3 integration/ui-fixes-native.py switch
python3 integration/ui-fixes-native.py business 3.44.0
node integration/ui-fixes-browser.mjs 3.44.0
```

seed 保留旧报告、重复批次、私有草稿和未知消费暂停样本；upgrade 在原实例换最终包并逐项核对。switch 保持同一数据库和安装实例，核对宿主升级后数据；business 在每个官方宿主上完成双账号三类测试。浏览器先检查无活动任务，再按新建批次 ID 等待六个持久任务完成，避免把旧总览的“全部完成”当成新批次完成。

浏览器每宿主实际发起六次本机受控请求，验证 Markdown、受限 MathML、原文复制、答案/请求直显、Key 搜索及 ID、长邮箱、说明浮层、历史返回、深色/柔光/自定义主题和 390/320px。弹窗不仅核对横向宽度，也核对 panel 与关闭按钮没有超出宿主可见高度；iframe 内容可能比屏幕高，使用 --plugin-viewport-height。查看、导出、切换主题、放大和刷新后账本不得新增模型调用。

报告和受控截图位于 .runtime/integration/ui141-{hostVersion}，原生业务证据在 ui141-native.json。只复制脱敏证据，不复制 control.json、数据库或原始请求头。结束时创建 .runtime/integration/stop，等 run_host.py 退出后运行 cleanup-ui.py；临时控制信息和四个监听必须清除。

---

# 1.4.0 官方 UI 与交互验收

使用 run_host.py 创建全新临时 CPR 3.39.0，注册官方 3.43.1 为唯一 matrix 目标。核对旧 1.3.1 与最终 1.4.0 归档后依次执行：

1. python3 integration/native_client.py --baseline dist/cloudops.codex-candy-eval-1.3.1-x86_64-unknown-linux-gnu.tar.gz
2. python3 integration/native-ui.py seed
3. python3 integration/native-ui.py upgrade
4. python3 integration/native-ui.py business
5. node integration/native-ui-browser.mjs

seed 写入历史、暂停样本、重复批次和草稿后请求宿主切换；upgrade 在原实例换包并核对声明和数据。business 验证三种受控测试、补测与停止；浏览器使用最终归档的真实 iframe 发起双账号指纹，核对恰好六次本机调用，并检查不透明来源、字体、主题、SVG、浮层、刷新和 390/320px。

主题测试调用临时宿主自身的主题 Store，并比较宿主和插件的实际变量；不会改生产或读真实账号。只复制脱敏报告和夹具截图到 docs，不复制 control.json、数据库或凭据。结束时创建 .runtime/integration/stop，等待清理并确认端口释放。

---

# 1.3.1 账号名称回归

仅使用下述 run_host.py 创建的全新临时 CPR 3.39.0。将原始 1.3.0 发布包和最终 1.3.1 包放在 dist，启动隔离宿主后依次执行：

```bash
python3 integration/accounts.py
python3 integration/accounts-blank-fixture.py --postgres-bin /path/to/postgresql/16/bin \
  --library-dir /path/to/tools/usr/lib/x86_64-linux-gnu
node integration/accounts-browser.mjs before
python3 integration/accounts-upgrade.py
node integration/accounts-browser.mjs after
```

accounts.py 只创建七个本机假账号、停用其中六个并安装原始包，不创建 Key 或模型任务。accounts-blank-fixture.py 校验回环地址和 /tmp/cpr-eval-* 临时目录，再通过该临时 PostgreSQL 的本地 socket 构造空名称；它不用于生产或现有数据库。此夹具验证空名称的显示路径，不证明生产账号同样为空。

before 验证原始包的空白标签及选择刷新恢复；upgrade 在原实例切换最终包，比较完整账号快照、草稿与已有集合，所有状态声明不变；after 验证邮箱/ID 标签、真实启停、搜索、刷新、深色主题和 390px 布局。两次浏览器检查均核对受控上游模型调用账本为零。证据保存在 .runtime/integration/accounts-*.json/png，安全副本见 docs 中对应的 1.3.1 文件。结束时按下述步骤停止宿主并清理临时数据。

---

# 1.3.0 隔离 CPR 验收

仅在本机启动临时 PostgreSQL、Redis、官方 CPR 和受控 Responses 上游，不使用生产账号或真实模型。端口 18380、18381、15432、16379 运行前应空闲。退出时停止自建进程、删除临时数据库及控制凭据。

先从官方 Release 下载 CPR Linux amd64 包并核对 checksums.txt；数据库工具可通过 prepare-ubuntu-tools.sh 下载解包，不安装系统服务。从全新 3.36.0 临时库起步，按顺序注册 3.38.2、3.39.0：

```bash
python3 integration/run_host.py --cpr-dir /path/to/3.36.0/codex-proxy-rs \
  --postgres-bin /path/to/tools/usr/lib/postgresql/16/bin \
  --redis-server /path/to/tools/usr/bin/redis-server \
  --library-dir /path/to/tools/usr/lib/x86_64-linux-gnu \
  --matrix-cpr-dir /path/to/3.38.2/codex-proxy-rs \
  --matrix-cpr-dir /path/to/3.39.0/codex-proxy-rs
```

看到 ready 后，在另一个终端运行。准备原始 1.2.1 发布包与当前 1.3.0 最终包到 dist，并将 workbench-matrix.py 的 hosts 目录设置为上述实际注册目录。脚本中自带目录对应本项目已有的本机发布缓存；换机器须修改它们。

```bash
python3 integration/native_client.py --baseline /path/to/1.2.1.tar.gz
python3 integration/workbench.py full 3.36.0
python3 integration/workbench-matrix.py
node integration/workbench-browser.mjs
```

native_client.py 只创建五个受控账号和测试 Key、旧包糖果报告。full 先用旧包创建暂停任务，再原实例切换当前最终归档，核对旧历史、详情、冻结计划及样本；然后验证五账号与跨批次全局上限 2、同账号互斥、快账号独立补位、两账号三次糖果、第三样本无效后只补一次、停止账号所有重复和实际 Core 租约归零、停止整个批次、未知消费不自动重放。每次构建必须在全新临时库开始；宿主不允许用同版本不同摘要覆盖已安装归档。

workbench-matrix.py 从低版本向高版本切换，在相同测试库核对各宿主上的最终归档、保留状态、目录、糖果与完整三样本指纹；再验证实际插件禁用/启用恢复、165 秒慢绘图、15 子任务达到 16 份保护上限及可选 Codex 上下文实际正文。慢绘图仅是本机夹具，先返回创建事件，165 秒后给出完整 SVG 和 usage，不调用真实模型。版本身份使用显式注册发布目录和程序 SHA-256，不依赖访问外部更新元数据的系统版本查询接口。不要将本流程用于生产或对生产库倒序降级。

浏览器脚本需要本机 Chrome 与 frontend 依赖；Windows 访问 WSL 回环可能需要相应进程权限。它核实实际宿主 iframe 禁止 localStorage，仍可通过私有状态提交双账号指纹，恰好六次受控调用；刷新恢复原批次且无新增请求，并检查完整结果复制回退、SVG 解码、明暗主题和 390px 布局。独立页面测试另验证 320px、旧 HTML、脚本与外部资源移除、内部渐变保留及已有作品对比。

报告保存在 docs/native-1.3.0-*.json；受控数据仅证明协议、持久化、调度和交互，不证明指纹识别准确率。临时控制信息与截图位于忽略的 .runtime/integration。结束时创建 .runtime/integration/stop，等待 run_host.py 退出，确认控制凭据、临时目录及四个端口均已清理。不要提交数据库、凭据或真实用户回答。

旧 business.py、lifecycle.py、optimization.py、migration.py、compatibility.py、tasks.py、pelican-*.py 及其版本报告保留历史回归，不是 1.3 默认验收入口。旧脚本关于账号数量、包名、任务或界面的假设可能与当前夹具不同；历史结果不能代替最终包验收。真实模型必须另外获得明确请求预算及凭据处理授权；没有新增授权时，不运行 real-model.py。
