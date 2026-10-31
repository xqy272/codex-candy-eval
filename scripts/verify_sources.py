"""校验固定的 SDK、题库、检测器与一致性样本。"""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def verify():
    source = json.loads((ROOT / "vendor/SOURCES.json").read_text(encoding="utf-8"))
    for name, expected in source["files"].items():
        actual = hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"固定来源摘要不匹配：{name}")
    print(f"PASS: {len(source['files'])} fixed source files")


if __name__ == "__main__":
    verify()
