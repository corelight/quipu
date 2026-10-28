import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from release_manifest import checksums, package_names


class ReleaseManifestTests(unittest.TestCase):
    def test_requires_exact_seven_packages(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in package_names('0.5.0'):
                (root / name).write_bytes(b'package')
            self.assertEqual(len(checksums(root, '0.5.0')), 7)
            (root / 'unexpected.dmg').write_bytes(b'unsigned')
            with self.assertRaises(ValueError):
                checksums(root, '0.5.0')
            (root / 'unexpected.dmg').unlink()
            (root / 'Quipu_0.5.0_amd64.deb').unlink()
            with self.assertRaises(ValueError):
                checksums(root, '0.5.0')

    def test_rejects_symlink_and_wrong_version(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in package_names('0.5.0'):
                (root / name).write_bytes(b'package')
            with self.assertRaises(ValueError):
                checksums(root, '0.4.0')
            path = root / 'Quipu_0.5.0_amd64.deb'
            path.unlink()
            path.symlink_to(root / 'Quipu_0.5.0_amd64.AppImage')
            with self.assertRaises(ValueError):
                checksums(root, '0.5.0')
