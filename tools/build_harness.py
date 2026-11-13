"""Build isolated harness candidates from shared sources; never deploy to a host."""
import argparse
import hashlib
import json
from pathlib import Path, PureWindowsPath
from preview_sync import safe_child


def sha(data):
    return hashlib.sha256(data).hexdigest()


def add_output(files, relative, data):
    if "\\" in relative or PureWindowsPath(relative).drive or any(p in ("", ".", "..") for p in relative.split("/")):
        raise ValueError(f"Unsafe output path: {relative}")
    key = relative.casefold()
    for existing in files:
        other = existing.casefold()
        if key == other or key.startswith(other + "/") or other.startswith(key + "/"):
            raise ValueError(f"Overlapping output paths: {relative} and {existing}")
    files[relative] = data


def apply_delta(data, delta):
    """Apply an exact-base adapter delta; shared-source changes require rebasing."""
    if sha(data) != delta["base_sha256"]:
        raise ValueError("Shared source changed; review and rebase the adapter delta")
    lines = data.decode("utf-8-sig").splitlines(keepends=True)
    output, cursor = [], 0
    for change in delta["changes"]:
        start, end = change["start"], change["end"]
        if not isinstance(start, int) or not isinstance(end, int) or not cursor <= start <= end <= len(lines):
            raise ValueError("Invalid or overlapping adapter delta")
        output.extend(lines[cursor:start])
        output.extend(change["replacement"])
        cursor = end
    output.extend(lines[cursor:])
    result = "".join(output).encode("utf-8")
    if sha(result) != delta["result_sha256"]:
        raise ValueError("Adapter delta result does not match its reviewed hash")
    return result


# Evidence covers discovery/loading, not semantic equivalence of native roles.
VERIFIED_COMPONENTS = {"codex": {"rules", "skills"}, "deepseek-harness": {"skills"},
                       "claude-code": set(), "antigravity": set()}


def build(repo, harness, output, target_home, *, components=None, mode="migrate"):
    selected = set(components) if components is not None else {"rules", "skills", "roles"}
    if not selected or not selected <= {"rules", "skills", "roles"}:
        raise ValueError("Select rules, skills and/or roles")
    if mode not in ("fresh", "migrate"):
        raise ValueError("Mode must be fresh or migrate")
    repo, output, target_home = repo.resolve(), output.resolve(), target_home.resolve()
    registry = json.loads((repo / "adapters/registry.json").read_text("utf-8-sig"))
    profile = registry[harness]
    if output == repo or output.is_relative_to(repo) or repo.is_relative_to(output):
        raise ValueError("Build output must be outside the source repository")
    if output == target_home or output.is_relative_to(target_home) or target_home.is_relative_to(output):
        raise ValueError("Build output must not overlap the target installation")
    if output.exists():
        raise FileExistsError("Use a new candidate directory; existing builds are preserved")
    inventory = json.loads((repo / "system-manifest.json").read_text("utf-8-sig"))
    delta_index = repo / "adapters" / harness / "skill-deltas.json"
    deltas = json.loads(delta_index.read_text("utf-8-sig")) if delta_index.exists() else {}
    used_deltas = set()
    files = {}
    for item in inventory["files"]:
        parts = item["source"].lower().replace("\\", "/").split("/")
        if any(p in (".git", "__pycache__", "node_modules", "auth.json", ".env") or p.startswith(".env.") for p in parts):
            raise ValueError("Private/runtime metadata cannot be a public source")
        source = safe_child(repo, item["source"])
        data = source.read_bytes()
        if sha(data) != item["sha256"]:
            raise ValueError(f"Source changed: {item['source']}")
        if item["source"] == "core/work-principles.md":
            fragment = safe_child(repo, f"adapters/{harness}/local-file-inspection.md").read_bytes().decode("utf-8-sig")
            text = data.decode("utf-8-sig").replace("{{HARNESS_NAME}}", profile["display_name"])
            data = text.replace("{{LOCAL_FILE_INSPECTION}}", fragment).encode("utf-8")
            if len(data) > profile.get("rule_max_bytes", float("inf")):
                raise ValueError("Rendered global rule exceeds this harness byte limit")
            add_output(files, profile["global_target"], data)
        elif item["source"].startswith("skills/"):
            if item["source"] in deltas:
                data = apply_delta(data, deltas[item["source"]])
                used_deltas.add(item["source"])
                if deltas[item["source"]].get("render_harness_home"):
                    data = data.decode("utf-8").replace("{{HARNESS_HOME}}", target_home.as_posix()).encode("utf-8")
            relative = item["source"][len("skills/"):]
            add_output(files, profile["skills_target"] + "/" + relative, data)
        elif profile["native_roles"] and item["source"].startswith("adapters/codex/agents/"):
            if item.get("render_codex_home"):
                data = data.decode("utf-8-sig").replace("{{CODEX_HOME}}", target_home.as_posix()).encode("utf-8")
            add_output(files, item["target"], data)
    if used_deltas != set(deltas):
        raise ValueError(f"Adapter delta refers to an unselected source: {sorted(set(deltas) - used_deltas)}")
    local_dependencies = []
    dependency_file = repo / "skills/local-dependencies.json"
    if dependency_file.exists():
        for item in json.loads(dependency_file.read_text("utf-8-sig"))["dependencies"]:
            relative = item["runtime_relative_path"]
            if not relative.startswith("skills/" + item["skill"] + "/"):
                raise ValueError("Local dependency is outside its owning skill")
            directory = relative.endswith("/")
            target = profile["skills_target"] + "/" + relative[len("skills/"):].rstrip("/")
            safe_child(output, target)
            key = target.casefold()
            if any(key == p.casefold() or key.startswith(p.casefold() + "/") or
                   (not directory and p.casefold().startswith(key + "/")) for p in files):
                raise ValueError(f"Public output overlaps a private dependency: {target}")
            local_dependencies.append({"target": target, "kind": "directory" if directory else "file",
                "required": item["required"], "required_when": item["required_when"],
                "policy": item["policy"]})
    if harness == "antigravity":
        add_output(files, "plugins/dragon-ball-agent/plugin.json", json.dumps({
            "name": "dragon-ball-agent", "description": "Shared working methods and harness-specific integration"
        }, ensure_ascii=False, indent=2).encode("utf-8"))
    retained = profile.get("retain_local_targets", {})
    for relative in retained:
        if relative not in files:
            raise ValueError(f"Retained-local mapping has no candidate: {relative}")
        del files[relative]
    excluded_groups = []
    if components is not None:
        # Never install fragments of a skill whose entry or native variant is withheld.
        prefix = profile["skills_target"] + "/"
        for rel in retained:
            if rel.startswith(prefix):
                group = prefix + rel[len(prefix):].split("/")[0] + "/"
                if group not in excluded_groups:
                    excluded_groups.append(group)
        files = {rel: data for rel, data in files.items()
                 if not any(rel.startswith(group) for group in excluded_groups)
                 and ((rel == profile["global_target"] and "rules" in selected)
                      or (rel.startswith(prefix) and "skills" in selected)
                      or (rel.startswith("agents/") and "roles" in selected))}
        if harness == "antigravity" and files:
            add_output(files, "plugins/dragon-ball-agent/plugin.json", json.dumps({
                "name": "dragon-ball-agent", "description": "Shared working methods and harness-specific integration"
            }, ensure_ascii=False, indent=2).encode("utf-8"))
        local_dependencies = [dep for dep in local_dependencies
                              if any(rel.startswith(prefix + dep["target"][len(prefix):].split("/")[0] + "/")
                                     for rel in files)]
        retained = ({rel: reason for rel, reason in retained.items()
                     if (rel.startswith(prefix) and "skills" in selected)
                     or (rel == profile["global_target"] and "rules" in selected)}
                    if mode == "migrate" else {})
    # All files are prepared and checked before the first output write.
    seen = set()
    for path in files:
        safe_child(output, path)
        if path.casefold() in seen:
            raise ValueError(f"Duplicate output: {path}")
        seen.add(path.casefold())
    output.mkdir(parents=True)
    manifest = {"schema_version": 1, "harness": harness, "complete_system": False,
                "bound_target_root": str(target_home),
                "deployment_ready": components is not None and selected <= VERIFIED_COMPONENTS[harness] and bool(files),
                "selected_components": sorted(selected), "install_mode": mode,
                "excluded_skill_groups": excluded_groups,
                "retained_required": components is None, "files": [],
                "retain_local_targets": retained,
                "local_dependencies": local_dependencies,
                "unmigrated_components": profile["unresolved"]}
    for relative, data in files.items():
        file = safe_child(output, relative)
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(data)
        manifest["files"].append({"source": relative, "target": relative, "sha256": sha(data)})
    (output / "candidate-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harness", choices=["codex", "claude-code", "deepseek-harness", "antigravity"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-home", type=Path, required=True)
    parser.add_argument("--components", nargs="+", choices=["rules", "skills", "roles"])
    parser.add_argument("--mode", choices=["fresh", "migrate"], default="migrate")
    args = parser.parse_args()
    result = build(Path(__file__).resolve().parents[1], args.harness, args.output, args.target_home, components=args.components, mode=args.mode)
    print(json.dumps({"harness": args.harness, "files": len(result["files"]),
                      "deployment_ready": result["deployment_ready"],
                      "unmigrated_components": result["unmigrated_components"]}, indent=2))
