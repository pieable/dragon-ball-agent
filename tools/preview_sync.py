"""Read-only comparison of explicitly approved files with a Codex installation."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_child(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()) or path == root.resolve():
        raise ValueError(f"Path escapes root: {relative}")
    return path


def classify(candidate, current, previous):
    if current == candidate:
        return "unchanged"
    if previous is None:
        return "new" if current is None else "conflict"
    if current is None:
        return "local-deletion"  # A missing managed file is a local edit, not a new file.
    if current == previous:
        return "update"
    if candidate == previous:
        return "local-change"
    return "conflict"


def make_plan(repo, home, manifest, installed_hashes=None):
    records = []
    seen = set()
    for item in manifest["files"]:
        target = safe_child(home, item["target"])
        if str(target).casefold() in seen:
            raise ValueError(f"Duplicate target: {item['target']}")
        seen.add(str(target).casefold())
        source = safe_child(repo, item["source"])
        data = source.read_bytes()
        if digest(data) != item["sha256"]:
            raise ValueError(f"Source changed since approval: {item['source']}")
        if item.get("render_policy"):
            fragment = safe_child(repo, item["policy_fragment"]).read_bytes()
            if digest(fragment) != item["policy_fragment_sha256"]:
                raise ValueError("Policy fragment changed since approval")
            data = data.decode("utf-8-sig").replace("{{HARNESS_NAME}}", "Codex").replace(
                "{{LOCAL_FILE_INSPECTION}}", fragment.decode("utf-8-sig")).encode("utf-8")
        if item.get("render_codex_home"):
            data = data.decode("utf-8-sig").replace("{{CODEX_HOME}}", home.resolve().as_posix()).encode("utf-8")
        current = target.read_bytes() if target.is_file() else None
        candidate_hash = digest(data)
        current_hash = digest(current) if current is not None else None
        previous_hash = (installed_hashes or {}).get(item["target"])
        status = "conflict" if target.exists() and not target.is_file() else classify(candidate_hash, current_hash, previous_hash)
        records.append({"source": item["source"], "target": item["target"], "status": status,
                        "candidate_sha256": candidate_hash,
                        "current_sha256": current_hash, "installed_sha256": previous_hash})
    return {"mode": "read-only", "complete_system": manifest["complete_system"], "files": records,
            "unmigrated_components": manifest["unmigrated_components"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex-home", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--state", type=Path, help="Private JSON object of target path to last installed SHA256")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    manifest_path = args.manifest or root / "system-manifest.json"
    state = json.loads(args.state.read_text("utf-8-sig")) if args.state else None
    result = make_plan(root, args.codex_home, json.loads(manifest_path.read_text("utf-8-sig")), state)
    print(json.dumps(result, ensure_ascii=False, indent=2))
