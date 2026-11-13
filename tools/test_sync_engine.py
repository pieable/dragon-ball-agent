"""Filesystem behavior tests; set TEMP/TMP/TMPDIR to the approved workspace."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import sync_engine as sync


class SyncTests(unittest.TestCase):
    def setUp(self):
        # Fail closed rather than silently write tests to the user's system temp.
        base = os.environ.get("TMPDIR") or os.environ.get("TEMP")
        if not base:
            raise RuntimeError("Set TMPDIR/TEMP explicitly to an approved test directory")
        Path(base).mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=base)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "candidate"
        self.target = self.root / "target"
        self.state = self.root / "state"
        self.source.mkdir()

    def manifest(self, files=None):
        files = files or {"a.txt": b"one"}
        result = {"deployment_ready": True, "files": []}
        for rel, content in files.items():
            p = self.source / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(content)
            result["files"].append({"source": rel, "target": rel, "sha256": sync.digest(content)})
        return result

    def apply(self, manifest):
        return sync.apply(self.source, self.target, self.state, manifest, explicit=True)

    def preview(self, manifest):
        return sync.preview(self.source, self.target, self.state, manifest)

    def rollback(self, transaction):
        return sync.rollback(self.target, self.state, transaction, explicit=True)

    def test_external_change_after_locked_plan_rejects_before_backup(self):
        self.apply(self.manifest())
        transactions = set((self.state / "transactions").iterdir())
        installed = (self.state / "installed.json").read_bytes()
        candidate = self.manifest({"a.txt": b"next version"})
        original_pending = sync._pending

        def change_after_plan(state):
            pending = original_pending(state)
            (self.target / "a.txt").write_bytes(b"external edit")
            return pending

        with patch.object(sync, "_pending", side_effect=change_after_plan):
            with self.assertRaisesRegex(sync.SyncError, "Target changed before backup"):
                self.apply(candidate)
        self.assertEqual((self.target / "a.txt").read_bytes(), b"external edit")
        self.assertEqual((self.state / "installed.json").read_bytes(), installed)
        # The rejected operation created neither a false backup nor a new transaction.
        self.assertEqual(set((self.state / "transactions").iterdir()), transactions)

    def test_preview_no_writes_and_explicit_apply(self):
        m = self.manifest()
        self.assertEqual(self.preview(m)["files"][0]["status"], "new")
        self.assertFalse(self.target.exists())
        self.assertFalse(self.state.exists())
        with self.assertRaises(sync.SyncError):
            sync.apply(self.source, self.target, self.state, m)
        m["deployment_ready"] = False
        self.assertEqual(self.preview(m)["mode"], "preview")
        with self.assertRaises(sync.SyncError):
            self.apply(m)

    def test_retained_dependency_missing_blocks_without_writes(self):
        m = self.manifest()
        m["retain_local_targets"] = {"skills/private.md": "Keep native behavior"}
        self.assertEqual(self.preview(m)["retained_local_dependencies"][0]["status"], "missing")
        with self.assertRaises(sync.SyncError):
            self.apply(m)
        self.assertFalse(self.target.exists())
        self.assertFalse(self.state.exists())
        retained = self.target / "skills/private.md"
        retained.parent.mkdir(parents=True)
        retained.write_bytes(b"local behavior")
        self.apply(m)
        self.assertEqual(retained.read_bytes(), b"local behavior")

    def test_retained_dependency_cannot_overlap_managed_output(self):
        m = self.manifest()
        for path in ("a.txt", "A.TXT", "../private", "a.txt/child"):
            m["retain_local_targets"] = {path: "invalid"}
            with self.subTest(path=path), self.assertRaises(sync.SyncError):
                self.preview(m)

    def test_conditional_private_materials_reported_not_claimed_loaded(self):
        m = self.manifest()
        m["local_dependencies"] = [{"target": "samples", "kind": "directory",
            "required": False, "required_when": "style imitation", "policy": "preserve_local_never_overwrite"}]
        result = self.preview(m)
        self.assertEqual(result["local_dependencies"][0]["status"], "missing")
        self.apply(m)
        (self.target / "samples").mkdir()
        result = self.preview(m)
        self.assertEqual(result["local_dependencies"][0]["status"], "path-present")
        self.assertFalse(result["local_dependencies"][0]["content_verified"])

    def test_required_private_material_missing_blocks(self):
        m = self.manifest()
        m["local_dependencies"] = [{"target": "profile.md", "kind": "file", "required": True}]
        with self.assertRaises(sync.SyncError):
            self.apply(m)
        self.assertFalse(self.target.exists())

    def test_private_dependency_file_directory_overlap_rejected(self):
        for kind, dependency, output in (("directory", "samples", "samples"),
                ("file", "private.md", "private.md/child"),
                ("directory", "samples/child", "samples"),
                ("file", "PRIVATE.MD", "private.md/child")):
            with self.subTest(kind=kind, dependency=dependency):
                # Source fixtures are independent to permit file/directory variants.
                candidate = self.root / ("case-" + str(len(list(self.root.iterdir()))))
                candidate.mkdir()
                path = candidate / output
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"output")
                m = {"deployment_ready": True, "files": [{"source": output,
                    "target": output, "sha256": sync.digest(b"output")}],
                    "local_dependencies": [{"target": dependency, "kind": kind, "required": False}]}
                with self.assertRaises(sync.SyncError):
                    sync.apply(candidate, self.target, self.state, m, explicit=True)
                self.assertFalse(self.target.exists())

    def test_install_update_and_rollback_with_private_files(self):
        self.target.mkdir()
        private = self.target / "private.env"
        private.write_bytes(b"private local data")
        first = self.apply(self.manifest({"nested/a.txt": b"first"}))
        self.assertEqual((self.target / "nested/a.txt").read_bytes(), b"first")
        second = self.apply(self.manifest({"nested/a.txt": b"second"}))
        self.assertEqual((self.target / "nested/a.txt").read_bytes(), b"second")
        self.assertEqual(self.rollback(second["transaction"])["status"], "rolled-back")
        self.assertEqual((self.target / "nested/a.txt").read_bytes(), b"first")
        self.rollback(first["transaction"])
        self.assertFalse((self.target / "nested/a.txt").exists())
        self.assertEqual(private.read_bytes(), b"private local data")
        self.assertFalse((self.state / "installed.json").exists())

    def test_first_conflict_aborts_whole_batch(self):
        self.target.mkdir()
        (self.target / "a.txt").write_bytes(b"user")
        m = self.manifest({"new.txt": b"new", "a.txt": b"candidate"})
        with self.assertRaises(sync.SyncError):
            self.apply(m)
        self.assertFalse((self.target / "new.txt").exists())
        self.assertFalse(self.state.exists())
        self.assertEqual((self.target / "a.txt").read_bytes(), b"user")

    def test_local_edit_and_deletion_preserved(self):
        m = self.manifest({"a.txt": b"a", "b.txt": b"b"})
        self.apply(m)
        (self.target / "a.txt").write_bytes(b"user")
        (self.target / "b.txt").unlink()
        p = self.preview(m)
        self.assertEqual([r["status"] for r in p["files"]], ["local-change", "local-deletion"])
        self.apply(m)
        self.assertEqual((self.target / "a.txt").read_bytes(), b"user")
        self.assertFalse((self.target / "b.txt").exists())
        changed = self.manifest({"a.txt": b"upstream", "b.txt": b"b2"})
        self.assertEqual(self.preview(changed)["files"][0]["status"], "conflict")
        with self.assertRaises(sync.SyncError):
            self.apply(changed)

    def test_same_file_adoption_and_unmapped_file_retained(self):
        self.target.mkdir()
        (self.target / "a.txt").write_bytes(b"one")
        m = self.manifest()
        self.assertEqual(self.preview(m)["files"][0]["status"], "unchanged")
        self.apply(m)
        self.apply(self.manifest({"other.txt": b"other"}))
        self.assertEqual((self.target / "a.txt").read_bytes(), b"one")
        self.assertIn("a.txt", json.loads((self.state / "installed.json").read_text())["files"])

    def test_tampered_source_and_invalid_paths(self):
        m = self.manifest()
        (self.source / "a.txt").write_bytes(b"tampered")
        with self.assertRaises(sync.SyncError):
            self.apply(m)
        for rel in ["../escape", "/absolute", "C:/absolute", "a/../../escape", "a\\b", "a:stream", "NUL", "a.", "a//b", ".dragon-ball-sync.lock"]:
            with self.subTest(rel=rel):
                m = self.manifest()
                m["files"][0]["target"] = rel
                with self.assertRaises(sync.SyncError):
                    self.apply(m)
        self.assertFalse(self.target.exists())

    def test_source_escape_duplicate_and_parent_collisions(self):
        m = self.manifest()
        m["files"][0]["source"] = "../outside"
        with self.assertRaises(sync.SyncError):
            self.preview(m)
        m = self.manifest()
        m["files"].append({**m["files"][0], "target": "A.txt"})
        with self.assertRaises(sync.SyncError):
            self.preview(m)
        m["files"][1]["target"] = "a.txt/nested"
        with self.assertRaises(sync.SyncError):
            self.preview(m)

    def test_root_overlap_rejected(self):
        m = self.manifest()
        for state in [self.target, self.target / "state", self.root]:
            with self.assertRaises(sync.SyncError):
                sync.preview(self.source, self.target, state, m)
        with self.assertRaises(sync.SyncError):
            sync.preview(self.source, self.source / "target", self.state, m)

    def test_symlink_or_junction_rejected(self):
        outside = self.root / "outside"
        outside.mkdir()
        self.target.mkdir()
        link = self.target / "linked"
        if os.name == "nt":
            subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], check=True, capture_output=True)
        else:
            link.symlink_to(outside, target_is_directory=True)
        try:
            m = self.manifest()
            m["files"][0]["target"] = "linked/a.txt"
            with self.assertRaises(sync.SyncError):
                self.apply(m)
            with self.assertRaises(sync.SyncError):
                sync.preview(self.source, link, self.state, self.manifest())
            self.assertFalse((outside / "a.txt").exists())
        finally:
            # Remove only the verified link; never traverse or remove its target.
            if os.name == "nt":
                os.rmdir(link)
            else:
                link.unlink()

    def test_target_lock_is_shared_across_state_directories(self):
        m = self.manifest()
        with sync._lock(self.target):
            with self.assertRaises(sync.SyncError):
                sync.apply(self.source, self.target, self.root / "different-state", m, explicit=True)
        self.apply(m)

    def test_interrupted_apply_inspect_and_recover(self):
        m = self.manifest({"a.txt": b"a", "b.txt": b"b"})
        original = sync._atomic

        def fail_second(path, data):
            if path == self.target / "b.txt":
                raise OSError("simulated interruption")
            return original(path, data)

        with patch.object(sync, "_atomic", side_effect=fail_second):
            with self.assertRaises(OSError):
                self.apply(m)
        txid = next((self.state / "transactions").iterdir()).name
        report = sync.inspect_transaction(self.target, self.state, txid)
        self.assertEqual(report["status"], "applying")
        self.assertEqual([r["status"] for r in report["files"]], ["after", "before"])
        with self.assertRaises(sync.SyncError):
            self.apply(m)
        self.rollback(txid)
        self.assertFalse((self.target / "a.txt").exists())
        self.apply(m)

    def test_rollback_does_not_overwrite_post_install_edit_or_deletion(self):
        result = self.apply(self.manifest())
        path = self.target / "a.txt"
        path.write_bytes(b"user")
        with self.assertRaises(sync.SyncError):
            self.rollback(result["transaction"])
        self.assertEqual(path.read_bytes(), b"user")
        # For a newly-created file, its deletion already equals the pre-install
        # state, so rollback may safely finish without recreating it.
        path.unlink()
        self.rollback(result["transaction"])
        self.assertFalse(path.exists())

    def test_update_rollback_preserves_user_deletion(self):
        self.apply(self.manifest())
        result = self.apply(self.manifest({"a.txt": b"two"}))
        (self.target / "a.txt").unlink()
        with self.assertRaises(sync.SyncError):
            self.rollback(result["transaction"])
        self.assertFalse((self.target / "a.txt").exists())

    def test_interrupted_rollback_can_resume(self):
        self.apply(self.manifest({"a.txt": b"old-a", "b.txt": b"old-b"}))
        result = self.apply(self.manifest({"a.txt": b"new-a", "b.txt": b"new-b"}))
        original = sync._atomic

        def fail_a(path, data):
            if path == self.target / "a.txt":
                raise OSError("interruption during rollback")
            return original(path, data)

        with patch.object(sync, "_atomic", side_effect=fail_a):
            with self.assertRaises(OSError):
                self.rollback(result["transaction"])
        observed = sync.inspect_transaction(self.target, self.state, result["transaction"])
        self.assertEqual(observed["status"], "rolling-back")
        self.assertEqual([r["status"] for r in observed["files"]], ["after", "before"])
        self.rollback(result["transaction"])
        self.assertEqual((self.target / "a.txt").read_bytes(), b"old-a")
        self.assertEqual((self.target / "b.txt").read_bytes(), b"old-b")

    def test_interruption_between_state_and_commit_is_recoverable(self):
        original = sync._save

        def fail_commit(path, value):
            if path.name == "journal.json" and value.get("status") == "committed":
                raise OSError("interruption after installed state write")
            return original(path, value)

        with patch.object(sync, "_save", side_effect=fail_commit):
            with self.assertRaises(OSError):
                self.apply(self.manifest())
        txid = next((self.state / "transactions").iterdir()).name
        self.assertTrue((self.state / "installed.json").exists())
        self.rollback(txid)
        self.assertFalse((self.target / "a.txt").exists())
        self.assertFalse((self.state / "installed.json").exists())

    def test_state_directory_lock_prevents_shared_state_race(self):
        with sync._lock(self.state):
            with self.assertRaises(sync.SyncError):
                self.apply(self.manifest())

    def test_backup_corruption_prevents_any_rollback_write(self):
        self.apply(self.manifest({"a.txt": b"old", "b.txt": b"old"}))
        result = self.apply(self.manifest({"a.txt": b"new", "b.txt": b"new"}))
        (self.state / "transactions" / result["transaction"] / "backups/0").write_bytes(b"bad")
        with self.assertRaises(sync.SyncError):
            self.rollback(result["transaction"])
        self.assertEqual((self.target / "a.txt").read_bytes(), b"new")
        self.assertEqual((self.target / "b.txt").read_bytes(), b"new")

    def test_older_rollback_cannot_undo_newer_state(self):
        first = self.apply(self.manifest())
        self.apply(self.manifest({"other.txt": b"two"}))
        with self.assertRaises(sync.SyncError):
            self.rollback(first["transaction"])

    def test_rendering_and_state_identity(self):
        m = self.manifest({"a.txt": b"{{CODEX_HOME}}/skills"})
        m["files"][0]["render_codex_home"] = True
        self.apply(m)
        self.assertEqual((self.target / "a.txt").read_text(), self.target.as_posix() + "/skills")
        with self.assertRaises(sync.SyncError):
            sync.preview(self.source, self.root / "other-target", self.state, m)

    def test_cli_defaults_to_preview(self):
        m = self.manifest()
        path = self.root / "manifest.json"
        path.write_text(json.dumps(m))
        result = subprocess.run([sys.executable, str(Path(sync.__file__)), "--source", str(self.source), "--target", str(self.target), "--state", str(self.state), "--manifest", str(path)], check=True, capture_output=True, text=True)
        self.assertEqual(json.loads(result.stdout)["mode"], "preview")
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
