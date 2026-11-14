"""Read MCP configuration shape without emitting values or starting tools.

Supply an exact native config path. Unknown integration names are not printed:
they can contain private project identifiers. No credentials or hashes of
credentials appear in the report. This is an installed-configuration inventory,
not a server health or authorization test.
"""
import argparse
import json
from pathlib import Path
import tomllib


def inventory(config, harness, catalog):
    if harness not in ("codex", "claude-code", "antigravity"):
        raise ValueError("This host's native MCP configuration loader is not mapped")
    raw = config.read_text("utf-8-sig")
    document = tomllib.loads(raw) if harness == "codex" else json.loads(raw)
    if not isinstance(document, dict):
        raise ValueError("Native configuration root must be an object")
    table = document.get("mcp_servers" if harness == "codex" else "mcpServers", {})
    if not isinstance(table, dict):
        raise ValueError("Invalid MCP server table")
    known = {item["id"]: item for item in catalog["components"]}
    for item in catalog["components"]:
        for alias in item.get("config_aliases", []):
            if alias in known:
                raise ValueError("Duplicate catalog identifier")
            known[alias] = item
    result, unknown = [], 0
    for name, entry in table.items():
        if name not in known:
            unknown += 1
            continue
        if not isinstance(entry, dict):
            result.append({"id": name, "status": "invalid-entry"})
            continue
        # Do not infer reachability, process health or loaded tools from a path.
        remote = isinstance(entry.get("url"), str) or (harness == "antigravity" and isinstance(entry.get("serverUrl"), str))
        transport = "remote" if remote else "stdio" if isinstance(entry.get("command"), str) else "unspecified"
        result.append({"id": name, "status": "configured",
                       "component_id": known[name]["id"],
                       "transport": transport,
                       "explicitly_disabled": entry.get("enabled") is False or entry.get("disabled") is True,
                       "has_local_env": bool(entry.get("env")),
                       "has_headers": bool(entry.get("headers")),
                       "source_status": known[name]["source_status"]})
    present = {known[item["id"]]["id"] for item in result}
    return {"harness": harness, "scope": "explicit-config-only",
            "health_checked": False, "configuration_changed": False,
            "integrations": result, "unlisted_entries_count": unknown,
            "not_in_this_config": sorted({item["id"] for item in catalog["components"]} - present)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harness", choices=["codex", "claude-code", "antigravity"])
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        catalog = json.loads((Path(__file__).resolve().parents[1] / "integrations/catalog.json").read_text("utf-8"))
        result = inventory(args.config, args.harness, catalog)
    except (OSError, ValueError, KeyError):
        # Parser exception strings may contain source lines with credentials.
        parser.exit(2, "Cannot inspect this configuration; check its path, format and native schema locally.\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))
