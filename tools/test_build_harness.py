import json
import tempfile
import unittest
from pathlib import Path
from build_harness import build, add_output, apply_delta, sha
from sync_engine import preview, SyncError


class AdapterTests(unittest.TestCase):
    def test_exact_base_delta_preserves_common_text(self):
        base, result = b"shared\nBash\nshared end\n", b"shared\npwsh\nshared end\n"
        delta = {"base_sha256": sha(base), "result_sha256": sha(result),
                 "changes": [{"start": 1, "end": 2, "replacement": ["pwsh\n"]}]}
        self.assertEqual(apply_delta(base, delta), result)
        with self.assertRaises(ValueError):
            apply_delta(b"changed\n" + base, delta)
        delta["changes"].append({"start": 0, "end": 1, "replacement": []})
        with self.assertRaises(ValueError):
            apply_delta(base, delta)

    def test_output_collisions_rejected_before_data_loss(self):
        for collision in ("skills/x/SKILL.md", "SKILLS/X/skill.md", "skills/x", "skills/x/SKILL.md/child"):
            with self.subTest(collision=collision):
                files = {}
                add_output(files, "skills/x/SKILL.md", b"original")
                with self.assertRaises(ValueError):
                    add_output(files, collision, b"replacement")
                self.assertEqual(files, {"skills/x/SKILL.md": b"original"})

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = Path(__file__).resolve().parents[1]

    def test_four_candidates_share_skill_bytes_without_deploying(self):
        for harness in ("codex", "claude-code", "deepseek-harness", "antigravity"):
            with self.subTest(harness=harness):
                out = self.root / harness
                home = self.root / (harness + "-installation")
                result = build(self.repo, harness, out, home)
                self.assertFalse(home.exists())
                self.assertFalse(result["deployment_ready"])
                prefix = "plugins/dragon-ball-agent/" if harness == "antigravity" else ""
                self.assertEqual((out / prefix / "skills/image-art-direction/SKILL.md").read_bytes(),
                                 (self.repo / "skills/image-art-direction/SKILL.md").read_bytes())
                for retained in result["retain_local_targets"]:
                    self.assertFalse((out / retained).exists())
                    self.assertNotIn(retained, [x["target"] for x in result["files"]])
                self.assertTrue((out / "candidate-manifest.json").is_file())
                self.assertEqual(len(result["local_dependencies"]), 10)
                self.assertTrue(all(x["target"].startswith(prefix + "skills/") for x in result["local_dependencies"]))
                if harness == "antigravity":
                    rule = out / prefix / "rules/AGENTS.md"
                    self.assertLessEqual(len(rule.read_bytes()), 24000)
                    self.assertEqual(json.loads((out / prefix / "plugin.json").read_text())["name"], "dragon-ball-agent")

    def test_existing_output_preserved(self):
        out = self.root / "candidate"
        out.mkdir()
        (out / "user.txt").write_text("retain")
        with self.assertRaises(FileExistsError):
            build(self.repo, "codex", out, self.root / "home")
        self.assertEqual((out / "user.txt").read_text(), "retain")

    def test_rendered_candidate_cannot_target_another_installation(self):
        out = self.root / "candidate"
        home = self.root / "rendered-home"
        manifest = build(self.repo, "codex", out, home)
        self.assertEqual(manifest["bound_target_root"], str(home.resolve()))
        with self.assertRaises(SyncError):
            preview(out, self.root / "different-home", self.root / "state", manifest)
        self.assertFalse((self.root / "different-home").exists())

    def test_target_overlap_rejected(self):
        with self.assertRaises(ValueError):
            build(self.repo, "codex", self.root / "home/output", self.root / "home")

    def test_orphan_adapter_delta_blocks_build(self):
        repo = self.root / "small-repo"
        (repo / "adapters/codex").mkdir(parents=True)
        (repo / "adapters/registry.json").write_text(json.dumps({"codex": {
            "display_name": "Codex", "native_roles": False, "unresolved": []}}))
        (repo / "system-manifest.json").write_text(json.dumps({"files": []}))
        (repo / "adapters/codex/skill-deltas.json").write_text(json.dumps({"skills/missing/SKILL.md": {}}))
        out = self.root / "orphan-output"
        with self.assertRaises(ValueError):
            build(repo, "codex", out, self.root / "installation")
        self.assertFalse(out.exists())

    def test_git_metadata_cannot_enter_public_candidates(self):
        repo = self.root / "invalid-repo"
        (repo / "adapters").mkdir(parents=True)
        (repo / "adapters/registry.json").write_text(json.dumps({"codex": {}}))
        (repo / "system-manifest.json").write_text(json.dumps({"files": [
            {"source": "skills/demo/.git/config"}]}))
        with self.assertRaisesRegex(ValueError, "metadata"):
            build(repo, "codex", self.root / "candidate", self.root / "home")
        self.assertFalse((self.root / "candidate").exists())


if __name__ == "__main__":
    unittest.main()
