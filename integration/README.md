# 真实 CPR 集成验收

这些脚本启动独立数据库、Redis、CPR 和本机受控上游，用假账号执行完整流程。不会访问真实模型。临时宿主只监听 `127.0.0.1:18380`，数据库和 Redis 使用 15432/16379，受控上游使用 18381；运行前这些端口应空闲。

已验证环境：Ubuntu 24.04 / WSL2，官方 CPR v3.35.1 Linux amd64 发行包，PostgreSQL 16.15、Redis 7.0.15；浏览器为本机 Chrome。数据库和账号是每次新建的隔离测试资源，不复用生产配置。插件不自行访问 SQL 或 Redis，持久化通过 CPR 公开 SDK。

先从官方 v3.35.1 Release 下载并按 `checksums.txt` 验证 Linux amd64 发行包，解压为 `/path/to/cpr`，保留其 `web/dist`。准备 PostgreSQL 与 Redis 程序；Ubuntu 24.04 可用以下脚本只下载并解压测试程序，不安装或启动系统服务：

```bash
bash integration/prepare-ubuntu-tools.sh
```

启动宿主并保持该进程运行：

```bash
python3 integration/run_host.py \
  --cpr-dir /path/to/cpr \
  --postgres-bin "$PWD/.runtime/integration-deps/tools/usr/lib/postgresql/16/bin" \
  --redis-server "$PWD/.runtime/integration-deps/tools/usr/bin/redis-server" \
  --library-dir "$PWD/.runtime/integration-deps/tools/usr/lib/x86_64-linux-gnu"
```

也可指向已准备好的测试程序。不要解析 Redis 可执行文件的符号链接后再传入，其运行模式依赖程序名。

出现 ready 后，在项目根目录的另一终端执行：

```bash
python integration/native_client.py
python integration/business.py
python integration/lifecycle.py
node integration/browser.mjs
```

`native_client.py` 要求测试宿主没有既有账号。可用 `--baseline /path/to/older-plugin.tar.gz` 安装兼容旧版本，随后验证升级和回滚；省略时安装当前包，不执行需要两个不同版本的回退用例。

浏览器脚本需要先在 `frontend` 执行 `npm ci`，并有本机 Chrome。Windows 可连接在同机 WSL 启动的宿主；在 Windows 项目目录执行客户端和浏览器命令即可。

覆盖的行为包括：安装加载、账号/模型目录、糖果判分和用量、三题指纹、SVG 原文与预览、错误与缺失终态、重复提交、取消和账号租约释放、题间取消、禁止换号、Key 范围与实际账号核对、运行时替换中断、历史保留、版本回退、原生页面刷新及深色窄屏。

结果、截图及临时控制信息保存在忽略提交的 `.runtime/integration/`。退出宿主进程，或创建该目录下的 `stop` 文件，会停止自建进程并清理临时数据库与控制凭据。测试报告和截图保留。Key、密码和 Cookie 不写入验收报告。
