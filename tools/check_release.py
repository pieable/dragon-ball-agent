"""Verify manifest hashes against Git's committed export, not working-tree bytes."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile


def check_archive(data):
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
        members = {m.name: m for m in archive.getmembers()}
        def read(name):
            member = members.get(name)
            if member is None or not member.isfile():
                raise ValueError(f"Missing regular file in export: {name}")
            return archive.extractfile(member).read()
        manifest = json.loads(read("system-manifest.json"))
        for item in manifest["files"]:
            if hashlib.sha256(read(item["source"])).hexdigest() != item["sha256"]:
                raise ValueError(f"Export source hash mismatch: {item['source']}")
            if item.get("policy_fragment"):
                if hashlib.sha256(read(item["policy_fragment"])).hexdigest() != item["policy_fragment_sha256"]:
                    raise ValueError("Export policy fragment hash mismatch")
        report = {"exported_sources_verified": len(manifest["files"])}
        integrations = 0
        for name in members:
            if name.startswith("integrations/") and name.endswith("/SOURCE.json"):
                provenance = json.loads(read(name))
                prefix = name.rsplit("/", 1)[0] + "/"
                for item in provenance["files"]:
                    relative = item["path"]
                    if relative.startswith("/") or "\\" in relative or any(x in ("", ".", "..") for x in relative.split("/")):
                        raise ValueError("Unsafe integration source path")
                    if hashlib.sha256(read(prefix + relative)).hexdigest() != item["public_sha256"]:
                        raise ValueError(f"Integration export hash mismatch: {prefix + relative}")
                    integrations += 1
        if integrations:
            report["integration_sources_verified"] = integrations
        return report


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    archive = subprocess.check_output(["git", "archive", "--format=tar", "HEAD"], cwd=root)
    print(json.dumps(check_archive(archive)))
