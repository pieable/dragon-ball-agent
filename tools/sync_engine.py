"""Explicit, file-scoped deployment with three-way conflict detection and recovery.

No harness paths are discovered. Callers supply a candidate root, target root,
private state root and an approved manifest. CLI defaults to preview. Transactions
retain backups; an interrupted transaction is recovered by explicit rollback.
The target's reserved .dragon-ball-sync.lock is a persistent advisory lock file.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import stat
import tempfile
import uuid


LOCK_NAME = ".dragon-ball-sync.lock"


class SyncError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def _check_path(path):
    """Reject every existing symlink or Windows reparse point, including ancestors."""
    path = Path(os.path.abspath(path))
    for part in [*reversed(path.parents), path]:
        try:
            s = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(s.st_mode) or getattr(s, "st_file_attributes", 0) & 0x400:
            raise SyncError(f"Link/reparse point is not allowed: {part}")
    return path


def _roots(target, state, source=None):
    target, state = _check_path(target), _check_path(state)
    if target == state or target in state.parents or state in target.parents:
        raise SyncError("Target and state directories must not overlap")
    for p in (target, state):
        if p.exists() and not p.is_dir():
            raise SyncError(f"Not a directory: {p}")
    if source is not None:
        source = _check_path(source)
        if not source.is_dir():
            raise SyncError("Candidate root must exist")
        for p in (target, state):
            if source == p or source in p.parents or p in source.parents:
                raise SyncError("Candidate root must not overlap target or state")
    return target, state


def _child(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise SyncError(f"Use a nonempty slash-separated relative path: {relative!r}")
    posix, windows = PurePosixPath(relative), PureWindowsPath(relative)
    if posix.is_absolute() or windows.drive or windows.is_absolute():
        raise SyncError(f"Absolute path is forbidden: {relative}")
    parts = relative.split("/")
    if any(p in ("", ".", "..") or ":" in p or p.rstrip(" .") != p for p in parts):
        raise SyncError(f"Unsafe relative path: {relative}")
    if any(PureWindowsPath(p).is_reserved() for p in parts):
        raise SyncError(f"Reserved path: {relative}")
    path = _check_path(Path(root).joinpath(*parts))
    for p in path.parents:
        if p == root:
            break
        if p.exists() and not p.is_dir():
            raise SyncError(f"Parent is not a directory: {p}")
    return path


def _bytes(path):
    _check_path(path)
    if not path.exists():
        return None
    if not path.is_file():
        raise SyncError(f"Expected a regular file: {path}")
    return path.read_bytes()


def _hash(path):
    data = _bytes(path)
    return digest(data) if data is not None else None


def _json(path):
    data = _bytes(path)
    return json.loads(data.decode("utf-8-sig")) if data is not None else None


def _atomic(path, data):
    _check_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _check_path(path.parent)
    fd, tmp = tempfile.mkstemp(prefix=".sync-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        _check_path(path)
        os.replace(tmp, path)
        if _bytes(path) != data:
            raise SyncError(f"Write verification failed: {path}")
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def _save(path, value):
    _atomic(path, (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode())


@contextmanager
def _lock(target):
    _check_path(target)
    target.mkdir(parents=True, exist_ok=True)
    lock = _child(target, LOCK_NAME)
    # A fixed inode/file is retained so competing callers cannot lock different
    # replacements. OS locks are released even if the process is terminated.
    with lock.open("a+b") as f:
        if f.tell() == 0:
            f.write(b"0")
            f.flush()
        f.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise SyncError("Another sync owns this target") from exc
        try:
            yield
        finally:
            f.seek(0)
            if os.name == "nt":
                msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def _state(state, target):
    value = _json(_child(state, "installed.json"))
    if value is not None:
        if value.get("target") != str(target) or not isinstance(value.get("files"), dict):
            raise SyncError("State belongs to a different target or has invalid files")
    return value


def classify(candidate, current, previous):
    if current == candidate:
        return "unchanged"
    if previous is None:
        return "new" if current is None else "conflict"
    if current is None:
        return "local-deletion"
    if current == previous:
        return "update"
    if candidate == previous:
        return "local-change"
    return "conflict"


def _plan(source, target, state, manifest):
    target, state = _roots(target, state, source)
    if manifest.get("bound_target_root") is not None and _check_path(manifest["bound_target_root"]) != target:
        raise SyncError("Candidate was rendered for a different target; rebuild for this installation")
    source = _check_path(source)
    old = _state(state, target)
    previous = old["files"] if old else {}
    records, payloads, seen = [], {}, set()
    for item in manifest["files"]:
        rel = item["target"]
        path = _child(target, rel)
        key = rel.casefold()
        if key == LOCK_NAME or key.startswith(LOCK_NAME + "/") or key in seen:
            raise SyncError(f"Duplicate or reserved target: {rel}")
        if any(key.startswith(k + "/") or k.startswith(key + "/") for k in seen):
            raise SyncError(f"Overlapping target paths: {rel}")
        seen.add(key)
        data = _bytes(_child(source, item["source"]))
        if data is None or digest(data) != item["sha256"]:
            raise SyncError(f"Candidate SHA256 mismatch: {item['source']}")
        if item.get("render_codex_home"):
            data = data.decode("utf-8-sig").replace("{{CODEX_HOME}}", target.as_posix()).encode()
        current, new = _hash(path), digest(data)
        record = {"target": rel, "source": item["source"],
                  "candidate_sha256": new, "current_sha256": current,
                  "installed_sha256": previous.get(rel),
                  "status": classify(new, current, previous.get(rel))}
        records.append(record)
        payloads[rel] = data
    retained = []
    for rel, reason in manifest.get("retain_local_targets", {}).items():
        key = rel.casefold()
        if key == LOCK_NAME or any(key == k or key.startswith(k + "/") or k.startswith(key + "/") for k in seen):
            raise SyncError(f"Retained-local target overlaps a managed or reserved path: {rel}")
        present = _hash(_child(target, rel)) is not None
        retained.append({"target": rel, "reason": reason,
                         "status": "present" if present else "missing"})
    local = []
    for item in manifest.get("local_dependencies", []):
        rel = item["target"]
        path = _child(target, rel)
        kind = item["kind"]
        if kind not in ("file", "directory") or not isinstance(item["required"], bool):
            raise SyncError("Invalid local dependency schema")
        key = rel.casefold()
        # A directory may contain a reviewed public index, but cannot itself
        # become a file. A private file cannot be any managed file's ancestor.
        if any(key == k or key.startswith(k + "/") or (kind == "file" and k.startswith(key + "/")) for k in seen):
            raise SyncError(f"Managed output overlaps local dependency: {rel}")
        if path.exists() and not (path.is_file() if kind == "file" else path.is_dir()):
            raise SyncError(f"Local dependency has wrong path type: {rel}")
        local.append({**item, "status": "path-present" if path.exists() else "missing",
                      "content_verified": False})
    return {"mode": "preview", "target": str(target), "files": records,
            "retained_local_dependencies": retained, "local_dependencies": local}, payloads, old


def preview(source, target, state, manifest):
    """Read-only, including when target/state directories do not yet exist."""
    return _plan(source, target, state, manifest)[0]


def _pending(state):
    directory = _child(state, "transactions")
    if not directory.exists():
        return []
    result = []
    for entry in directory.iterdir():
        _check_path(entry)
        journal = _json(_child(entry, "journal.json"))
        if journal and journal.get("status") not in ("committed", "rolled-back"):
            result.append(entry.name)
    return result


def adoption_plan(source, target, state, manifest):
    plan = preview(source, target, state, manifest)
    return {"schema_version": 1, "target": plan["target"],
            "manifest_sha256": digest(json.dumps(manifest, sort_keys=True).encode()),
            "files": [{**r, "decision": "unresolved"} for r in plan["files"]
                      if r["status"] in ("conflict", "local-change", "local-deletion")]}


def _adopt(plan, manifest, adoption):
    if adoption is None:
        return
    if adoption.get("target") != plan["target"] or adoption.get("manifest_sha256") != digest(json.dumps(manifest, sort_keys=True).encode()):
        raise SyncError("Adoption plan target/candidate changed; prepare a new plan")
    records = {r["target"]: r for r in plan["files"]}
    seen = set()
    for item in adoption["files"]:
        rel = item["target"]
        if rel in seen or rel not in records:
            raise SyncError("Invalid adoption target")
        seen.add(rel)
        record = records[rel]
        for key in ("candidate_sha256", "current_sha256", "installed_sha256", "status"):
            if record[key] != item[key]:
                raise SyncError("Adoption evidence is stale; prepare a new plan")
        if record["status"] not in ("conflict", "local-change", "local-deletion"):
            raise SyncError("Adoption only resolves divergent files")
        decision = item["decision"]
        if decision == "adopt" and record["installed_sha256"] is None:
            record["status"] = "update" if record["current_sha256"] else "new"
        elif decision in ("preserve", "export"):
            record["status"] = "unmanaged"
            record["export_local"] = decision == "export"
        else:
            raise SyncError("Choose preserve/export or initial reviewed adopt")


def apply(source, target, state, manifest, *, explicit=False, adoption=None):
    if not explicit:
        raise SyncError("Apply requires explicit=True (CLI: --apply)")
    if manifest.get("deployment_ready") is False:
        raise SyncError("Manifest is not deployment-ready; preview remains available")
    if "selected_components" in manifest:
        from build_harness import VERIFIED_COMPONENTS
        if not set(manifest["selected_components"]) <= VERIFIED_COMPONENTS.get(manifest.get("harness"), set()):
            raise SyncError("Selected native components have not passed loading validation")
    # Validate all candidates/paths before creating even the target lock.
    initial = preview(source, target, state, manifest)
    _adopt(initial, manifest, adoption)
    if manifest.get("retained_required", True) and any(r["status"] == "missing" for r in initial["retained_local_dependencies"]):
        raise SyncError("Required retained-local files are missing; no files were installed")
    if any(r["required"] and r["status"] == "missing" for r in initial["local_dependencies"]):
        raise SyncError("Required private dependencies are missing; no files were installed")
    if any(r["status"] == "conflict" for r in initial["files"]):
        raise SyncError("Conflicting files: no files were installed")
    target, state = _roots(target, state, source)
    with _lock(target), _lock(state):
        plan, payloads, old = _plan(source, target, state, manifest)
        _adopt(plan, manifest, adoption)
        if manifest.get("retained_required", True) and any(r["status"] == "missing" for r in plan["retained_local_dependencies"]):
            raise SyncError("Required retained-local files are missing; no files were installed")
        if any(r["required"] and r["status"] == "missing" for r in plan["local_dependencies"]):
            raise SyncError("Required private dependencies are missing; no files were installed")
        if any(r["status"] == "conflict" for r in plan["files"]):
            raise SyncError("Conflicting files: no files were installed")
        if _pending(state):
            raise SyncError("Unfinished transaction: inspect and rollback before applying")
        txid = uuid.uuid4().hex
        tx = _child(state, "transactions/" + txid)
        changes = []
        new_state = {"target": str(target), "files": dict(old["files"] if old else {})}
        for record in plan["files"]:
            rel, status = record["target"], record["status"]
            if status == "unmanaged":
                new_state["files"].pop(rel, None)
                if record.get("export_local"):
                    local = _bytes(_child(target, rel))
                    if (digest(local) if local is not None else None) != record["current_sha256"]:
                        raise SyncError("Local file changed before private export")
                    if local is not None:
                        _atomic(_child(tx, "local-exports/" + rel), local)
            if status in ("new", "update"):
                before = _bytes(_child(target, rel))
                if (digest(before) if before is not None else None) != record["current_sha256"]:
                    raise SyncError(f"Target changed before backup: {rel}; no backup was written for this file")
                index = str(len(changes))
                if before is not None:
                    _atomic(_child(tx, "backups/" + index), before)
                _atomic(_child(tx, "candidates/" + index), payloads[rel])
                changes.append({"target": rel, "index": index,
                                "before": record["current_sha256"],
                                "after": record["candidate_sha256"]})
            if status in ("new", "update", "unchanged"):
                new_state["files"][rel] = record["candidate_sha256"]
        journal = {"id": txid, "target": str(target), "status": "prepared",
                   "before_state": old, "after_state": new_state,
                   "changes": changes, "adoption": adoption}
        jp = _child(tx, "journal.json")
        _save(jp, journal)  # Durable intent and backups precede every target write.
        journal["status"] = "applying"
        _save(jp, journal)
        for change in changes:
            path = _child(target, change["target"])
            if _hash(path) != change["before"]:
                raise SyncError(f"Target changed during apply: {change['target']}; rollback {txid}")
            data = _bytes(_child(tx, "candidates/" + change["index"]))
            if digest(data) != change["after"]:
                raise SyncError("Staged candidate changed; rollback transaction")
            _atomic(path, data)
        for record in plan["files"]:
            if record["status"] in ("new", "update", "unchanged"):
                if _hash(_child(target, record["target"])) != record["candidate_sha256"]:
                    raise SyncError("Target verification changed before commit; inspect transaction")
        _save(_child(state, "installed.json"), new_state)
        journal["status"] = "committed"
        _save(jp, journal)
        return {**plan, "mode": "applied", "transaction": txid}


def inspect_transaction(target, state, transaction):
    target, state = _roots(target, state)
    if not isinstance(transaction, str) or len(transaction) != 32 or any(c not in "0123456789abcdef" for c in transaction):
        raise SyncError("Invalid transaction ID")
    tx = _child(state, "transactions/" + transaction)
    journal = _json(_child(tx, "journal.json"))
    if not journal or journal.get("target") != str(target) or journal.get("id") != transaction:
        raise SyncError("Missing transaction or target mismatch")
    observations = []
    for change in journal["changes"]:
        current = _hash(_child(target, change["target"]))
        status = "before" if current == change["before"] else "after" if current == change["after"] else "user-change"
        observations.append({"target": change["target"], "status": status, "current_sha256": current})
    return {"transaction": transaction, "status": journal["status"], "files": observations}


def rollback(target, state, transaction, *, explicit=False):
    if not explicit:
        raise SyncError("Rollback requires explicit=True (CLI: --rollback)")
    target, state = _roots(target, state)
    inspect_transaction(target, state, transaction)
    with _lock(target), _lock(state):
        report = inspect_transaction(target, state, transaction)
        tx = _child(state, "transactions/" + transaction)
        jp = _child(tx, "journal.json")
        journal = _json(jp)
        current_state = _state(state, target)
        if current_state not in (journal["before_state"], journal["after_state"]):
            raise SyncError("Installed state changed since transaction; rollback refused")
        if journal["status"] == "rolled-back":
            return report
        if any(r["status"] == "user-change" for r in report["files"]):
            raise SyncError("User changed installed files; rollback refused without overwriting")
        restore = {}
        for change in journal["changes"]:
            if change["before"] is not None:
                data = _bytes(_child(tx, "backups/" + change["index"]))
                if data is None or digest(data) != change["before"]:
                    raise SyncError("Backup SHA256 mismatch; rollback refused")
                restore[change["target"]] = data
        journal["status"] = "rolling-back"
        _save(jp, journal)
        for change in reversed(journal["changes"]):
            path = _child(target, change["target"])
            current = _hash(path)
            if current == change["before"]:
                continue
            if current != change["after"]:
                raise SyncError("Target changed during rollback; transaction remains recoverable")
            if change["before"] is None:
                path.unlink()
                if path.exists():
                    raise SyncError("Removal verification failed")
            else:
                _atomic(path, restore[change["target"]])
        installed = _child(state, "installed.json")
        if journal["before_state"] is None:
            if installed.exists():
                installed.unlink()
        else:
            _save(installed, journal["before_state"])
        journal["status"] = "rolled-back"
        _save(jp, journal)
        return inspect_transaction(target, state, transaction)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--manifest", type=Path)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--apply", action="store_true")
    action.add_argument("--prepare-adoption", action="store_true")
    parser.add_argument("--adoption-plan", type=Path)
    action.add_argument("--rollback", metavar="TRANSACTION")
    action.add_argument("--inspect", metavar="TRANSACTION")
    args = parser.parse_args()
    try:
        if args.rollback:
            result = rollback(args.target, args.state, args.rollback, explicit=True)
        elif args.inspect:
            result = inspect_transaction(args.target, args.state, args.inspect)
        else:
            if args.source is None or args.manifest is None:
                parser.error("--source and --manifest are required for preview/apply")
            manifest = json.loads(args.manifest.read_text("utf-8-sig"))
            if args.prepare_adoption:
                result = adoption_plan(args.source, args.target, args.state, manifest)
            elif args.apply:
                adoption = _json(args.adoption_plan) if args.adoption_plan else None
                result = apply(args.source, args.target, args.state, manifest, explicit=True, adoption=adoption)
            else:
                result = preview(args.source, args.target, args.state, manifest)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (SyncError, OSError, ValueError, KeyError) as exc:
        parser.exit(2, str(exc) + "\n")


if __name__ == "__main__":
    main()
