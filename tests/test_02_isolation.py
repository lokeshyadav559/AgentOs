"""
ACL / grants tests. Mirrors test/02-isolation.test.ts §22 #2.
"""
import pytest
from agentos.acl.grants import check_fs_op, normalize_path, path_within, network_allowed
from agentos.domain.types import FilesystemGrant, SessionManifestEnvironment, Networking


def _grant(folder, read=True, write=True, delete=False):
    return FilesystemGrant(folderPath=folder, canRead=read, canWrite=write, canDelete=delete)


def test_normalize_path():
    assert normalize_path("/foo/bar") == "/foo/bar"
    assert normalize_path("foo/bar") == "/foo/bar"
    assert normalize_path("/foo/../bar") is None  # traversal
    assert normalize_path("/") == "/"


def test_path_within():
    assert path_within("/agents/default", "/agents/default/file.txt")
    assert path_within("/agents/default", "/agents/default")
    assert not path_within("/agents/default", "/agents/other/file.txt")
    assert path_within("/", "/anything")


def test_check_fs_op_read_allowed():
    grants = [_grant("/agents/default")]
    ok, _ = check_fs_op(grants, "read", "/agents/default/notes.txt")
    assert ok


def test_check_fs_op_read_denied():
    grants = [_grant("/agents/default")]
    ok, reason = check_fs_op(grants, "read", "/agents/other/file.txt")
    assert not ok
    assert "no read grant" in reason


def test_check_fs_op_delete_denied():
    grants = [_grant("/agents/default", delete=False)]
    ok, reason = check_fs_op(grants, "delete", "/agents/default/file.txt")
    assert not ok
    assert "no delete grant" in reason


def test_check_fs_op_delete_allowed():
    grants = [_grant("/agents/default", delete=True)]
    ok, _ = check_fs_op(grants, "delete", "/agents/default/file.txt")
    assert ok


def test_path_traversal_denied():
    grants = [_grant("/agents/default")]
    ok, reason = check_fs_op(grants, "read", "/agents/default/../secrets")
    assert not ok
    assert "path escape" in reason


def test_network_allowed_open():
    env = SessionManifestEnvironment(networking=Networking.open, allowedHosts=[])
    assert network_allowed(env, "api.github.com")


def test_network_allowed_limited():
    env = SessionManifestEnvironment(networking=Networking.limited, allowedHosts=["api.front.com"])
    assert network_allowed(env, "api.front.com")
    assert not network_allowed(env, "api.github.com")


def test_network_allowed_no_env():
    assert network_allowed(None, "anything.com")
