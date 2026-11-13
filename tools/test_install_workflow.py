import json
import tempfile
import unittest
from pathlib import Path
from build_harness import build
import sync_engine as sync


class InstallationWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = Path(__file__).resolve().parents[1]
        self.target, self.state = self.root / "target", self.root / "state"
        self.source = self.root / "candidate"

    def test_verified_codex_subset_installs_in_empty_target(self):
        m = build(self.repo, "codex", self.source, self.target, components=["rules", "skills"], mode="fresh")
        self.assertTrue(m["deployment_ready"])
        sync.apply(self.source, self.target, self.state, m, explicit=True)
        self.assertTrue((self.target / "AGENTS.md").exists())
        self.assertFalse((self.target / "agents").exists())

    def test_dsh_fresh_excludes_whole_divergent_groups(self):
        m = build(self.repo, "deepseek-harness", self.source, self.target, components=["skills"], mode="fresh")
        self.assertTrue(m["deployment_ready"])
        self.assertFalse(m["retain_local_targets"])
        self.assertEqual(len(m["excluded_skill_groups"]), 5)
        sync.apply(self.source, self.target, self.state, m, explicit=True)
        self.assertFalse((self.target / "skills/code-development").exists())
        self.assertTrue((self.target / "skills/image-art-direction/SKILL.md").exists())

    def test_migration_preserves_existing_native_group_without_requiring_it(self):
        self.target.mkdir()
        retained = self.target / "skills/code-review/SKILL.md"
        retained.parent.mkdir(parents=True)
        retained.write_bytes(b"private native contract")
        m = build(self.repo, "deepseek-harness", self.source, self.target, components=["skills"])
        sync.apply(self.source, self.target, self.state, m, explicit=True)
        self.assertEqual(retained.read_bytes(), b"private native contract")
        self.assertFalse((retained.parent / "references").exists())

    def test_unverified_components_block_even_if_flag_changed(self):
        for i, (host, components) in enumerate([("codex", ["roles"]), ("claude-code", ["skills"]), ("antigravity", ["rules"])]):
            source = self.root / str(i)
            m = build(self.repo, host, source, self.target, components=components, mode="fresh")
            self.assertFalse(m["deployment_ready"])
            m["deployment_ready"] = True
            with self.assertRaises(sync.SyncError):
                sync.apply(source, self.target, self.state, m, explicit=True)
        self.assertFalse(self.target.exists())

    def test_blocked_agy_subset_still_has_native_plugin_metadata(self):
        m = build(self.repo, "antigravity", self.source, self.target, components=["skills"], mode="fresh")
        self.assertFalse(m["deployment_ready"])
        self.assertTrue((self.source / "plugins/dragon-ball-agent/plugin.json").is_file())
        self.assertFalse((self.source / "plugins/dragon-ball-agent/rules/AGENTS.md").exists())

    def fixture(self):
        self.source.mkdir(); self.target.mkdir()
        (self.source / "a").write_bytes(b"public")
        (self.target / "a").write_bytes(b"private")
        return {"deployment_ready": True, "files": [{"source": "a", "target": "a", "sha256": sync.digest(b"public")}]}

    def test_adopt_backup_update_and_rollback(self):
        m = self.fixture()
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "adopt"
        result = sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        self.assertEqual((self.target / "a").read_bytes(), b"public")
        sync.rollback(self.target, self.state, result["transaction"], explicit=True)
        self.assertEqual((self.target / "a").read_bytes(), b"private")
        self.assertFalse((self.state / "installed.json").exists())

    def test_preserve_and_export_leave_local_unmanaged(self):
        m = self.fixture()
        for decision in ["preserve", "export"]:
            plan = sync.adoption_plan(self.source, self.target, self.state, m)
            plan["files"][0]["decision"] = decision
            result = sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
            self.assertEqual((self.target / "a").read_bytes(), b"private")
            self.assertEqual(sync.preview(self.source, self.target, self.state, m)["files"][0]["status"], "conflict")
            with self.assertRaises(sync.SyncError):
                sync.apply(self.source, self.target, self.state, m, explicit=True)
            self.assertNotIn("a", json.loads((self.state / "installed.json").read_text())["files"])
            if decision == "export":
                self.assertEqual((self.state / "transactions" / result["transaction"] / "local-exports/a").read_bytes(), b"private")

    def test_managed_local_edit_requires_export_before_re_adoption(self):
        m = self.fixture()
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "adopt"
        sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        (self.target / "a").write_bytes(b"new local work")
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "adopt"
        with self.assertRaises(sync.SyncError):
            sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        self.assertEqual((self.target / "a").read_bytes(), b"new local work")
        plan["files"][0]["decision"] = "export"
        sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "adopt"
        sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        self.assertEqual((self.target / "a").read_bytes(), b"public")

    def test_stale_adoption_refused(self):
        m = self.fixture()
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "adopt"
        (self.target / "a").write_bytes(b"new private work")
        with self.assertRaises(sync.SyncError):
            sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        self.assertFalse(self.state.exists())
        (self.target / "a").write_bytes(b"private")
        m["extra"] = "changed candidate"
        with self.assertRaises(sync.SyncError):
            sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)

    def test_export_reconcile_rebuild_adopt_update(self):
        m = self.fixture()
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "export"
        sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        (self.source / "a").write_bytes(b"reviewed merged")
        m["files"][0]["sha256"] = sync.digest(b"reviewed merged")
        plan = sync.adoption_plan(self.source, self.target, self.state, m)
        plan["files"][0]["decision"] = "adopt"
        sync.apply(self.source, self.target, self.state, m, explicit=True, adoption=plan)
        (self.source / "a").write_bytes(b"next version")
        m["files"][0]["sha256"] = sync.digest(b"next version")
        result = sync.apply(self.source, self.target, self.state, m, explicit=True)
        self.assertEqual((self.target / "a").read_bytes(), b"next version")
        sync.rollback(self.target, self.state, result["transaction"], explicit=True)
        self.assertEqual((self.target / "a").read_bytes(), b"reviewed merged")
