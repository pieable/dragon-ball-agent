import hashlib
import tempfile
import unittest
from pathlib import Path
from preview_sync import make_plan, classify


class PreviewTests(unittest.TestCase):
    def test_three_way_change_ownership(self):
        self.assertEqual(classify("new", "old", "old"), "update")
        self.assertEqual(classify("old", "local", "old"), "local-change")
        self.assertEqual(classify("new", "local", "old"), "conflict")
        self.assertEqual(classify("new", None, "old"), "local-deletion")
        self.assertEqual(classify("same", "same", "old"), "unchanged")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / "repo"
        self.home = self.root / "home"
        self.repo.mkdir()
        data = b"read {{CODEX_HOME}}/skills/example"
        (self.repo / "agent.toml").write_bytes(data)
        self.manifest = {"complete_system": False, "unmigrated_components": ["skills"], "files": [{
            "source": "agent.toml", "target": "agents/example.toml",
            "sha256": hashlib.sha256(data).hexdigest(), "render_codex_home": True}]}

    def test_missing_target_does_not_write(self):
        plan = make_plan(self.repo, self.home, self.manifest)
        self.assertEqual(plan["files"][0]["status"], "new")
        self.assertFalse(self.home.exists())

    def test_conflict_preserves_user_content(self):
        target = self.home / "agents/example.toml"
        target.parent.mkdir(parents=True)
        target.write_bytes(b"user edit")
        self.assertEqual(make_plan(self.repo, self.home, self.manifest)["files"][0]["status"], "conflict")
        self.assertEqual(target.read_bytes(), b"user edit")

    def test_source_change_rejected(self):
        (self.repo / "agent.toml").write_bytes(b"unreviewed content")
        with self.assertRaises(ValueError):
            make_plan(self.repo, self.home, self.manifest)

    def test_path_escape_rejected(self):
        self.manifest["files"][0]["target"] = "../outside"
        with self.assertRaises(ValueError):
            make_plan(self.repo, self.home, self.manifest)

    def test_rendered_equal(self):
        target = self.home / "agents/example.toml"
        target.parent.mkdir(parents=True)
        target.write_text("read " + self.home.resolve().as_posix() + "/skills/example", encoding="utf-8")
        self.assertEqual(make_plan(self.repo, self.home, self.manifest)["files"][0]["status"], "unchanged")


if __name__ == "__main__":
    unittest.main()
