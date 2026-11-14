import json
from pathlib import Path
import tempfile
import unittest
from integration_inventory import inventory


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.config = Path(self.temp.name) / "config"
        self.catalog = {"components": [{"id": "known", "source_status": "retain-installed"}]}

    def test_json_values_and_unknown_names_not_disclosed(self):
        self.config.write_text(json.dumps({"mcpServers": {
            "private-project": {"url": "secret-url"},
            "known": {"command": "secret-path", "args": ["secret-arg"],
                      "env": {"secret-name": "secret-value"}, "disabled": True}}}))
        for host in ("claude-code", "antigravity"):
            result = inventory(self.config, host, self.catalog)
            self.assertEqual(result["unlisted_entries_count"], 1)
            self.assertTrue(result["integrations"][0]["explicitly_disabled"])
            self.assertNotIn("secret", json.dumps(result))
            self.assertNotIn("private-project", json.dumps(result))

    def test_codex_toml(self):
        self.config.write_text('[mcp_servers.known]\nurl="private-url"\nenabled=false\n')
        result = inventory(self.config, "codex", self.catalog)
        self.assertEqual(result["integrations"][0]["transport"], "remote")
        self.assertFalse(result["health_checked"])

    def test_unsupported_loader_not_assumed(self):
        with self.assertRaises(ValueError):
            inventory(self.config, "deepseek-harness", self.catalog)

    def test_registered_alias_resolves_component_without_exposing_values(self):
        self.catalog['components'][0]['config_aliases'] = ['known-native']
        self.config.write_text('[mcp_servers.known-native]\ncommand="private-path"\n')
        result = inventory(self.config, 'codex', self.catalog)
        self.assertEqual(result['integrations'][0]['component_id'], 'known')
        self.assertEqual(result['integrations'][0]['id'], 'known-native')
        self.assertEqual(result['not_in_this_config'], [])
        self.assertEqual(result['unlisted_entries_count'], 0)
        self.assertNotIn('private-path', json.dumps(result))

    def test_ambiguous_alias_is_rejected(self):
        self.catalog['components'][0]['config_aliases'] = ['known']
        self.config.write_text('{}')
        with self.assertRaises(ValueError):
            inventory(self.config, 'claude-code', self.catalog)

    def test_invalid_alias_entry_retains_component_identity(self):
        self.catalog['components'][0]['config_aliases'] = ['known-native']
        self.config.write_text('{"mcpServers":{"known-native":false}}')
        result = inventory(self.config, 'claude-code', self.catalog)
        self.assertEqual(result['integrations'][0], {
            'id': 'known-native', 'component_id': 'known', 'status': 'invalid-entry'})

    def test_native_legacy_url_alias(self):
        self.config.write_text('{"mcpServers":{"known":{"serverUrl":"private-url"}}}')
        self.assertEqual(inventory(self.config, "antigravity", self.catalog)["integrations"][0]["transport"], "remote")
        self.assertEqual(inventory(self.config, "claude-code", self.catalog)["integrations"][0]["transport"], "unspecified")

    def test_invalid_root_rejected(self):
        for value in ([], None, "private-value"):
            self.config.write_text(json.dumps(value))
            with self.assertRaises(ValueError):
                inventory(self.config, "antigravity", self.catalog)


if __name__ == "__main__":
    unittest.main()
