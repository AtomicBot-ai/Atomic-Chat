"""Exercise the demo's key handoff without importing its optional UI dependencies."""

import ast
import asyncio
import json
import os
import pathlib
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock, patch


SOURCE = (
    pathlib.Path(__file__).resolve().parents[1]
    / "scripts/concurrent-demo/demo/main.py"
)


def load_helpers():
    names = {
        "_write_session_api_key",
        "_remove_session_api_key",
        "_resolve_session_api_key",
        "_run_multi_window",
    }
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    nodes = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in names
    ]
    namespace = {
        "__builtins__": __builtins__,
        "Any": object,
        "pathlib": pathlib,
        "os": os,
        "asyncio": asyncio,
        "json": json,
        "tempfile": tempfile,
        "sys": types.SimpleNamespace(platform="darwin"),
        "_API_KEY_FILENAME": "api_key",
    }
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), "exec"), namespace)
    return namespace


class SessionKeyTests(unittest.TestCase):
    def setUp(self):
        self.helpers = load_helpers()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.session_dir = pathlib.Path(self.temp.name)

    def test_key_file_is_private_and_existing_files_are_not_overwritten(self):
        write = self.helpers["_write_session_api_key"]
        write(self.session_dir, "test-key")
        key_path = self.session_dir / "api_key"
        self.assertEqual(key_path.read_text(), "test-key")
        if os.name == "posix":
            self.assertEqual(key_path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            write(self.session_dir, "replacement")
        self.assertEqual(key_path.read_text(), "test-key")

    @unittest.skipUnless(os.name == "posix", "POSIX symlink permissions")
    def test_key_writer_refuses_a_symlink(self):
        target = self.session_dir / "retained-data"
        target.write_text("keep")
        (self.session_dir / "api_key").symlink_to(target)
        with self.assertRaises(FileExistsError):
            self.helpers["_write_session_api_key"](self.session_dir, "test-key")
        self.assertEqual(target.read_text(), "keep")

    def test_env_key_takes_precedence_over_ephemeral_and_legacy_keys(self):
        self.helpers["_write_session_api_key"](self.session_dir, "file-key")
        resolve = self.helpers["_resolve_session_api_key"]
        with patch.dict(os.environ, {"ATOMIC_API_KEY": "env-key"}):
            self.assertEqual(resolve({"api_key": "legacy"}, self.session_dir), "env-key")
        with patch.dict(os.environ, {"ATOMIC_API_KEY": ""}):
            self.assertEqual(resolve({"api_key": "legacy"}, self.session_dir), "file-key")
            self.helpers["_remove_session_api_key"](self.session_dir)
            self.assertEqual(resolve({"api_key": "legacy"}, self.session_dir), "legacy")

    def test_launch_failures_remove_key_but_retain_nonsecret_session(self):
        for failed_launcher in ("_spawn_dashboard_window", "_spawn_terminal_windows"):
            with self.subTest(launcher=failed_launcher):
                settings = types.SimpleNamespace(
                    model="test-model", base_url="http://localhost:1337/v1", api_key="test-key"
                )
                client = types.SimpleNamespace(aclose=AsyncMock())
                self.helpers.update({
                    "ClientSettings": types.SimpleNamespace(from_env=lambda: settings),
                    "get_scenario": Mock(return_value={"agents": [{
                        "name": "agent", "direct_instruction": "Do {topic}"
                    }]}),
                    "Console": Mock(return_value=Mock()),
                    "build_async_client": Mock(return_value=client),
                    "_run_plan": AsyncMock(return_value=[{"name": "agent", "instruction": "Do test"}]),
                    "_get_main_display_size": Mock(return_value=(1440, 900)),
                    "_spawn_dashboard_window": Mock(),
                    "_spawn_terminal_windows": Mock(),
                })
                self.helpers[failed_launcher].side_effect = OSError("launch failed")
                with patch.object(tempfile, "mkdtemp", return_value=str(self.session_dir)):
                    with self.assertRaisesRegex(OSError, "launch failed"):
                        asyncio.run(self.helpers["_run_multi_window"](
                            scenario_name="test", topic="test", tasks=1, open_browser=False
                        ))
                self.assertFalse((self.session_dir / "api_key").exists())
                payload = json.loads((self.session_dir / "session.json").read_text())
                self.assertNotIn("api_key", payload)
                self.assertNotIn("test-key", json.dumps(payload))
                client.aclose.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
