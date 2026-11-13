#!/usr/bin/env python3
"""Safely replace the glossary JSON embedded in an HTML file."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


class ValidationError(ValueError):
    """Raised when the input data or HTML does not match the contract."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValidationError(f"JSON 中字段 {key!r} 重复出现")
        result[key] = value
    return result


def _reject_nonfinite(value: str) -> None:
    raise ValidationError(f"JSON 中不能包含非有限数值 {value}")


def _object(value: Any, where: str, required: set[str], optional: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{where} 必须是对象")
    keys = set(value)
    missing = required - keys
    if missing:
        raise ValidationError(f"{where} 缺少必填字段：{', '.join(sorted(missing))}")
    unknown = keys - required - optional
    if unknown:
        raise ValidationError(f"{where} 包含未定义字段：{', '.join(sorted(unknown))}")
    return value


def _string(value: Any, where: str, *, nonempty: bool = False) -> str:
    if not isinstance(value, str):
        raise ValidationError(f"{where} 必须是字符串")
    if nonempty and not value.strip():
        raise ValidationError(f"{where} 不能为空")
    return value


def _string_array(value: Any, where: str) -> None:
    if not isinstance(value, list):
        raise ValidationError(f"{where} 必须是数组")
    for index, item in enumerate(value):
        _string(item, f"{where}[{index}]")


def validate_data(data: Any) -> None:
    root = _object(data, "root", {"project", "updated", "entries"}, set())
    _string(root["project"], "project")
    _string(root["updated"], "updated")
    entries = root["entries"]
    if not isinstance(entries, list):
        raise ValidationError("entries 必须是数组")

    ids: set[str] = set()
    related_ids: list[tuple[str, str]] = []
    for index, raw_entry in enumerate(entries):
        where = f"entries[{index}]"
        entry = _object(
            raw_entry,
            where,
            {"id", "term", "domain", "meaning"},
            {"group", "english", "example", "distinction", "aliases", "phrases", "related", "sources"},
        )
        for field in ("id", "term", "domain", "meaning"):
            _string(entry[field], f"{where}.{field}", nonempty=True)
        entry_id = entry["id"]
        if entry_id in ids:
            raise ValidationError(f"词条 id {entry_id!r} 重复")
        ids.add(entry_id)

        for field in ("group", "english", "example", "distinction"):
            if field in entry:
                _string(entry[field], f"{where}.{field}")

        if "aliases" in entry:
            _string_array(entry["aliases"], f"{where}.aliases")

        if "phrases" in entry:
            phrases = entry["phrases"]
            if not isinstance(phrases, list):
                raise ValidationError(f"{where}.phrases 必须是数组")
            for phrase_index, raw_phrase in enumerate(phrases):
                phrase_where = f"{where}.phrases[{phrase_index}]"
                phrase = _object(raw_phrase, phrase_where, {"text", "context"}, set())
                _string(phrase["text"], f"{phrase_where}.text")
                _string(phrase["context"], f"{phrase_where}.context")

        if "related" in entry:
            related = entry["related"]
            if not isinstance(related, list):
                raise ValidationError(f"{where}.related 必须是数组")
            for related_index, raw_related in enumerate(related):
                related_where = f"{where}.related[{related_index}]"
                relation = _object(raw_related, related_where, {"id", "note"}, set())
                target_id = _string(relation["id"], f"{related_where}.id", nonempty=True)
                _string(relation["note"], f"{related_where}.note")
                related_ids.append((target_id, related_where))

        if "sources" in entry:
            sources = entry["sources"]
            if not isinstance(sources, list):
                raise ValidationError(f"{where}.sources 必须是数组")
            for source_index, raw_source in enumerate(sources):
                source_where = f"{where}.sources[{source_index}]"
                source = _object(raw_source, source_where, {"label", "url"}, set())
                _string(source["label"], f"{source_where}.label")
                url = _string(source["url"], f"{source_where}.url")
                try:
                    parsed = urlsplit(url)
                    # Accessing .port also detects malformed numeric ports.
                    _ = parsed.port
                    hostname = parsed.hostname
                except ValueError as exc:
                    raise ValidationError(f"{source_where}.url 不是有效网址") from exc
                if (
                    parsed.scheme.lower() not in {"http", "https"}
                    or not hostname
                    or any(ord(char) <= 32 or ord(char) == 127 for char in url)
                ):
                    raise ValidationError(f"{source_where}.url 必须是以 HTTP 或 HTTPS 开头的绝对网址")

    for target_id, where in related_ids:
        if target_id not in ids:
            raise ValidationError(f"{where}.id 指向不存在的词条 id {target_id!r}")


class _TargetScriptParser(HTMLParser):
    """Locate the one glossary-data script and retain exact character offsets."""

    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=False)
        self._source = source
        self._line_starts = [0]
        self._line_starts.extend(index + 1 for index, char in enumerate(source) if char == "\n")
        self._active: dict[str, int] | None = None
        self.matches: list[tuple[int, int]] = []
        self.errors: list[str] = []

    def _absolute(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "script":
            return
        attr_map: dict[str, list[str | None]] = {}
        for key, value in attrs:
            attr_map.setdefault(key.lower(), []).append(value)
        ids = attr_map.get("id", [])
        if "glossary-data" not in ids:
            return
        if len(ids) != 1 or len(attr_map.get("type", [])) != 1:
            self.errors.append("glossary-data script 的 id 或 type 属性重复或缺失")
            return
        if attr_map["type"][0] != "application/json":
            self.errors.append("glossary-data script 的 type 必须是 application/json")
            return
        if self._active is not None:
            self.errors.append("glossary-data script 不能嵌套在另一个目标 script 中")
            return
        self._active = {"content_start": self._absolute() + len(self.get_starttag_text())}

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "script" or self._active is None:
            return
        self.matches.append((self._active["content_start"], self._absolute()))
        self._active = None

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "script" and any(
            key.lower() == "id" and value == "glossary-data" for key, value in attrs
        ):
            self.errors.append("glossary-data script 不能使用自闭合标签")

    def finish(self) -> tuple[int, int]:
        self.close()
        if self.errors:
            raise ValidationError(self.errors[0])
        if self._active is not None:
            raise ValidationError("glossary-data script 缺少闭合的 </script> 标签")
        if len(self.matches) != 1:
            raise ValidationError(
                f"HTML 中必须恰有一个包含 glossary-data 的 application/json script，实际找到 {len(self.matches)} 个"
            )
        return self.matches[0]


def _find_script_content(source: str) -> tuple[int, int]:
    parser = _TargetScriptParser(source)
    try:
        parser.feed(source)
        return parser.finish()
    except ValidationError:
        raise
    except Exception as exc:
        raise ValidationError("HTML 无法解析") from exc


def _encode_payload(data: Any) -> bytes:
    serialized = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    serialized = (
        serialized.replace("<", r"\u003c")
        .replace(">", r"\u003e")
        .replace("&", r"\u0026")
        .replace("\u2028", r"\u2028")
        .replace("\u2029", r"\u2029")
    )
    try:
        return serialized.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise ValidationError("JSON 中包含无效的 Unicode 字符，无法编码为 UTF-8") from exc


def update_html(html_path: Path, json_path: Path) -> None:
    raw_data = json_path.read_bytes()
    try:
        data_text = raw_data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValidationError("JSON 文件必须使用 UTF-8 编码") from exc
    try:
        data = json.loads(
            data_text,
            object_pairs_hook=_reject_duplicate_keys,
            parse_constant=_reject_nonfinite,
        )
    except json.JSONDecodeError as exc:
        raise ValidationError(f"JSON 格式无效（第 {exc.lineno} 行，第 {exc.colno} 列）") from exc
    validate_data(data)

    raw_html = html_path.read_bytes()
    try:
        html_text = raw_html.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValidationError("HTML 文件必须使用 UTF-8 编码") from exc
    char_start, char_end = _find_script_content(html_text)
    byte_start = len(html_text[:char_start].encode("utf-8"))
    byte_end = len(html_text[:char_end].encode("utf-8"))
    replacement = raw_html[:byte_start] + _encode_payload(data) + raw_html[byte_end:]

    directory = html_path.parent
    mode = stat.S_IMODE(html_path.stat().st_mode)
    temp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=directory, prefix=f".{html_path.name}.", suffix=".tmp", delete=False) as temporary:
            temp_path = temporary.name
            temporary.write(replacement)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temp_path, mode)
        os.replace(temp_path, html_path)
        temp_path = None
    finally:
        if temp_path is not None:
            try:
                os.unlink(temp_path)
            except FileNotFoundError:
                pass


class _ChineseHelpFormatter(argparse.HelpFormatter):
    def _format_usage(self, usage: str | None, actions: list[Any], groups: list[Any], prefix: str | None = None) -> str:
        return super()._format_usage(usage, actions, groups, "用法：" if prefix is None else prefix)


class _ChineseArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_usage(sys.stderr)
        self.exit(2, f"{self.prog}: 参数错误，请使用 --help 查看用法。\n")


def main(argv: list[str] | None = None) -> int:
    parser = _ChineseArgumentParser(
        description="校验 JSON 词汇表数据，并原子替换 HTML 中唯一的 glossary-data 数据块。",
        formatter_class=_ChineseHelpFormatter,
        add_help=False,
    )
    parser._positionals.title = "位置参数"
    parser._optionals.title = "可选参数"
    parser.add_argument("--help", "-h", action="help", help="显示此帮助信息并退出")
    parser.add_argument("html", type=Path, metavar="HTML", help="包含 glossary-data 数据块的 HTML 文件")
    parser.add_argument("json", type=Path, metavar="JSON", help="UTF-8 编码（可带 BOM）的 JSON 词汇表数据文件")
    args = parser.parse_args(argv)
    try:
        update_html(args.html, args.json)
    except ValidationError as exc:
        print(f"更新词汇表失败：{exc}", file=sys.stderr)
        return 1
    except (OSError, RecursionError):
        print("更新词汇表失败：文件读写失败，请检查输入路径、权限和文件状态。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
