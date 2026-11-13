import hashlib
import io
import json
import tarfile
import unittest
from check_release import check_archive


class ExportTests(unittest.TestCase):
    def make_archive(self, expected, actual):
        out = io.BytesIO()
        manifest = {"files": [{"source": "source.md", "sha256": hashlib.sha256(expected).hexdigest()}]}
        with tarfile.open(fileobj=out, mode="w:") as archive:
            for name, data in {"source.md": actual, "system-manifest.json": json.dumps(manifest).encode()}.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        return out.getvalue()

    def test_export_newline_conversion_detected(self):
        with self.assertRaises(ValueError):
            check_archive(self.make_archive(b"line\r\n", b"line\n"))

    def test_identical_export_passes(self):
        self.assertEqual(check_archive(self.make_archive(b"line\r\n", b"line\r\n")),
                         {"exported_sources_verified": 1})


if __name__ == "__main__":
    unittest.main()
