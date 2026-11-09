"""离线核对安装包摘要、文件集合、平台和资源，不执行插件。"""
import argparse
import hashlib
import json
from pathlib import Path
import posixpath
import re
import tarfile


def check(archive: Path):
    expected = Path(str(archive) + ".sha256").read_text(encoding="utf-8").split()[0]
    actual = hashlib.sha256(archive.read_bytes()).hexdigest()
    if actual != expected:
        raise ValueError("安装包 SHA-256 不匹配")
    with tarfile.open(archive, "r:gz") as package:
        files = {}
        modes = {}
        for member in package.getmembers():
            if not member.isfile() or member.name in files:
                raise ValueError("归档中存在目录、链接或重复项")
            files[member.name] = package.extractfile(member).read()
            modes[member.name] = member.mode
    manifest = json.loads(files["plugin.json"])
    packaged = manifest["package"]
    if set(files) != {"plugin.json", *packaged["files"]}:
        raise ValueError("归档内容与清单不一致")
    for name, digest in packaged["files"].items():
        if hashlib.sha256(files[name]).hexdigest() != digest:
            raise ValueError(f"资源 SHA-256 不匹配：{name}")
    # The host resolves CSS URLs through declared static resources, including fonts.
    # Pre-inlined data URLs pass a browser-only preview but fail native page assembly.
    for name, content_type in manifest["resources"].items():
        if name.startswith("web/") and len(files[name]) > 1024 * 1024:
            raise ValueError(f"单个管理资源超过宿主上限：{name}")
        if content_type != "text/css":
            continue
        for match in re.finditer(r"url\(\s*([^)]+?)\s*\)", files[name].decode("utf-8")):
            reference = match[1].strip().strip("\"'")
            if reference.startswith("#"):
                continue
            if ":" in reference or reference.startswith("/") or "\\" in reference:
                raise ValueError(f"CSS 必须引用包内已声明资源：{name}")
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), reference))
            if resolved not in manifest["resources"]:
                raise ValueError(f"CSS 引用未声明资源：{resolved}")
    if not modes[manifest["main"]] & 0o111:
        raise ValueError("插件程序没有执行权限")
    target = packaged["target"]
    if target == {"os": "linux", "architecture": "x86_64"}:
        binary = files[manifest["main"]]
        if binary[:5] != b"\x7fELF\x02" or int.from_bytes(binary[18:20], "little") != 62:
            raise ValueError("程序不是 Linux x86_64 ELF")
    source = json.loads(files["vendor/SOURCES.json"])
    if source["detectorRevision"] != "sha256:" + hashlib.sha256(files["data/shared_detector.bin"]).hexdigest():
        raise ValueError("检测器来源摘要不匹配")
    result = {"archive": str(archive), "sha256": actual, "bytes": archive.stat().st_size, "files": len(files), "protocol": packaged["protocolVersion"], "target": target}
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    check(parser.parse_args().archive.resolve())
