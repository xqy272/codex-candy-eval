"""构建自包含 CPR 插件归档，不上传、不安装、不调用模型。"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
from verify_sources import verify
from check_package import check

ROOT = Path(__file__).resolve().parents[1]
TARGETS = ("x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin")


def run(args, cwd=ROOT):
    subprocess.run([str(v) for v in args], cwd=cwd, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=TARGETS)
    args = parser.parse_args()
    cli = shutil.which(os.environ.get("PLUGIN_CLI", "cpr-plugin"))
    if not cli:
        parser.error("未找到官方 cpr-plugin CLI，请设置 PLUGIN_CLI；参见 README")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if not npm:
        parser.error("需要 Node.js 24+ 和 npm")
    verify()
    run([npm, "ci", "--no-audit", "--no-fund"], ROOT / "frontend")
    run([npm, "run", "build"], ROOT / "frontend")
    run(["cargo", "+1.99.1", "build", "--release", "--locked", "--target", args.target, "--target-dir", ROOT / "backend/target", "--manifest-path", ROOT / "backend/Cargo.toml"])
    run([cli, "package", "--manifest", ROOT / "plugin.json", "--binary", ROOT / f"backend/target/{args.target}/release/cpr-candy-eval", "--target", args.target, "--resource-map", "web=frontend/dist", "--output-dir", ROOT / "dist"])
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    check(ROOT / f"dist/{manifest['publisher']}.{manifest['name']}-{manifest['version']}-{args.target}.tar.gz")


if __name__ == "__main__":
    main()
