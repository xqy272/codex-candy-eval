# 隔离 CPR 验收

run_host.py 只在本机启动临时 PostgreSQL、Redis、官方 CPR 和受控 Responses 上游。默认不用生产账号或真实模型。端口为 18380、18381、15432、16379，运行前应空闲。退出后会停止自建进程、删除临时数据库及控制凭据。

从官方 Release 下载 CPR Linux amd64 包并核对 checksums.txt，将含 codex-proxy-rs 与 web/dist 的目录传入 --cpr-dir。数据库工具可通过 prepare-ubuntu-tools.sh 下载解包，不安装系统服务。

```bash
python3 integration/run_host.py --cpr-dir /path/to/cpr \
  --postgres-bin /path/to/tools/usr/lib/postgresql/16/bin \
  --redis-server /path/to/tools/usr/bin/redis-server \
  --library-dir /path/to/tools/usr/lib/x86_64-linux-gnu
```

看到 ready 后，在另一个终端执行：

```bash
# 在 CPR 3.36 上使用真实旧包建立历史，然后原实例升级
python integration/native_client.py --baseline /path/to/1.1.2.tar.gz
python integration/compatibility.py
python integration/tasks.py
node integration/browser.mjs
```

新宿主也可省略 --baseline，直接安装当前包。tasks.py 会明确区分原实例升级与当前包直接安装。compatibility.py 对最终归档验证账号与 Key、模型目录、旧状态、幂等糖果和完整三样本指纹，报告保存在 docs/compatibility-VERSION.json。

tasks.py 覆盖后台执行、重复提交、三份固定题目、SVG 输出、大事件流、失败暂停、无效样本、手动续测、取消、进程替换的未知消费、Key 作用域和删除。受控上游计数用于检查插件是否重复请求，不与上游 attempt 或真实用户 turn 混淆。

browser.mjs 读取已完成任务，通过真实宿主 iframe 与 CSP 检查报告、完整证据导出、刷新、主题和窄屏。需要本机 Chrome 与 frontend 的依赖。Windows 连接 WSL 回环可能需要相应进程权限。

旧的 business.py、lifecycle.py 和 optimization.py 保留同步接口与旧历史的回归；不代表新版页面仍驱动逐题执行。migration.py 是 1.1.1 的历史故障复现，不是 1.2 的默认验收入口。

真实模型验收必须另外明确授权、固定请求预算及凭据处理范围。测试数据和控制信息保存在忽略的 .runtime/integration；不得把凭据、数据库或原始用户回答整体提交。公开证据只保留必要的次数、状态、样本有效性和有界汇总。

## 同库版本矩阵

验证原始 1.0.0 时，先在 CPR 3.35.1 启动，传 --upgrade-cpr-dir 指向 3.36.0。准备原始 1.0.0 与 1.1.2 发布包到 dist 后，运行 native_client.py --baseline 指向 1.0.0，再运行 upgrade-current.py。宿主同一插件只允许一个启用实例，脚本会停用先前测试实例，再独立验证 1.1.2 升级。

run_host.py 可以重复传 --matrix-cpr-dir 注册 3.37.2 与 3.38.2 测试程序目录。依次运行 switch-host.py 0 3.37.2、compatibility.py、switch-host.py 1 3.38.2、compatibility.py，再执行 tasks.py 与 browser.mjs。只切换启动时注册的程序，同一临时数据库保持；不要对生产目录使用这些脚本。

compatibility.py 保存当前运行目录与实际观测版本。tasks.py 使用该快照并逐项保存进度，避免结束时刷新系统版本失败而丢失已通过的检查。cancellation.py 额外观察真实 Core 租约出现，再确认停止后归零。
