#!/usr/bin/env python3
"""Build Codex Mini release zip artifacts with fixed manifests and checks."""

from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


PLACEHOLDER = "__CODEX_MINI_RELAY_REGISTRATION_KEY__"

DESKTOP_FILES = [
    "server.js",
    "package.json",
    "package-lock.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "start-codex-mini-relay.bat",
    "start-codex-mini-relay.command",
]
DESKTOP_DIRS = ["public", "bin"]
DESKTOP_SCRIPTS = [
    "scripts/start-windows-relay.ps1",
    "scripts/start-macos-relay.sh",
]
DESKTOP_OUTPUT = "codex-mini-desktop-universal.zip"

SERVER_FILES = ["package.json", "package-lock.json"]
SERVER_DIRS = ["relay-server"]
SERVER_OUTPUT = "codex-mini-relay-server.zip"

EXECUTABLE_ENTRIES = {
    "start-codex-mini-relay.command",
    "scripts/start-macos-relay.sh",
    "bin/codex-window-point",
    "relay-server/install-full.sh",
    "relay-server/install-systemd.sh",
}
LF_TEXT_ENTRIES = {
    "start-codex-mini-relay.command",
    "scripts/start-macos-relay.sh",
    "relay-server/install-full.sh",
    "relay-server/install-systemd.sh",
}

DESKTOP_FORBIDDEN_PREFIXES = (
    ".git/",
    "node_modules/",
    "relay-server/",
    "macos/",
    ".runtime/",
    "logs/",
)
DESKTOP_FORBIDDEN_NAMES = {"登录二维码.png", "登录链接.txt"}

SERVER_FORBIDDEN_PREFIXES = (
    ".git/",
    "node_modules/",
    "public/",
    "bin/",
    "scripts/",
    "macos/",
    ".runtime/",
    "logs/",
)
SERVER_FORBIDDEN_NAMES = {
    "server.js",
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "start-codex-mini-relay.bat",
    "start-codex-mini-relay.command",
    "登录二维码.png",
    "登录链接.txt",
}


class PackageError(RuntimeError):
    pass


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        values[key] = value
    return values


def registration_key(args: argparse.Namespace) -> str:
    key = args.registration_key or os.environ.get("CODEX_MINI_RELAY_REGISTRATION_KEY", "")
    if not key and args.env_file:
        values = parse_env_file(Path(args.env_file))
        key = values.get("CODEX_MINI_RELAY_REGISTRATION_KEY", "")
    key = key.strip()
    if not key or key == PLACEHOLDER:
        raise PackageError(
            "desktop packaging needs CODEX_MINI_RELAY_REGISTRATION_KEY "
            "via --registration-key, --env-file, or environment."
        )
    if "'" in key:
        raise PackageError("registration key cannot contain a single quote; refusing unsafe script injection.")
    return key


def posix_entry(path: Path | str) -> str:
    return str(PurePosixPath(str(path).replace("\\", "/")))


def iter_tree(root: Path, rel_dir: str) -> list[str]:
    base = root / rel_dir
    if not base.is_dir():
        raise PackageError(f"missing required directory: {rel_dir}")
    entries: list[str] = []
    for path in sorted(base.rglob("*")):
        if path.is_file():
            rel = posix_entry(path.relative_to(root))
            if rel.endswith("/devices.json") or rel.endswith("/devices.json.bak"):
                continue
            entries.append(rel)
    return entries


def require_files(root: Path, entries: list[str]) -> None:
    missing = [entry for entry in entries if not (root / entry).is_file()]
    if missing:
        raise PackageError(f"missing required file(s): {', '.join(missing)}")


def zip_info(entry: str, mode: int | None = None) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(entry)
    if mode is None:
        mode = 0o755 if entry in EXECUTABLE_ENTRIES else 0o644
    info.external_attr = (stat.S_IFREG | mode) << 16
    info.create_system = 3
    return info


def read_entry_bytes(root: Path, entry: str, key: str | None = None) -> bytes:
    data = (root / entry).read_bytes()
    if entry in LF_TEXT_ENTRIES:
        data = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    if key is not None and entry in DESKTOP_SCRIPTS:
        text = data.decode("utf-8")
        text = text.replace(
            "DEFAULT_REGISTRATION_KEY='__CODEX_MINI_RELAY_REGISTRATION_KEY__'",
            f"DEFAULT_REGISTRATION_KEY='{key}'",
        )
        text = text.replace(
            "$DefaultRegistrationKey = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'",
            f"$DefaultRegistrationKey = '{key}'",
        )
        data = text.encode("utf-8")
    return data


def write_zip(root: Path, output: Path, entries: list[str], key: str | None = None) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            zf.writestr(zip_info(entry), read_entry_bytes(root, entry, key))


def check_forbidden(entries: list[str], prefixes: tuple[str, ...], names: set[str], label: str) -> None:
    bad = [
        entry
        for entry in entries
        if entry in names or any(entry == prefix[:-1] or entry.startswith(prefix) for prefix in prefixes)
    ]
    if bad:
        raise PackageError(f"{label} package contains forbidden entries: {', '.join(bad)}")


def desktop_entries(root: Path) -> list[str]:
    entries = [*DESKTOP_FILES, *DESKTOP_SCRIPTS]
    for rel_dir in DESKTOP_DIRS:
        entries.extend(iter_tree(root, rel_dir))
    require_files(root, entries)
    entries = sorted(dict.fromkeys(entries))
    check_forbidden(entries, DESKTOP_FORBIDDEN_PREFIXES, DESKTOP_FORBIDDEN_NAMES, "desktop")
    return entries


def server_entries(root: Path) -> list[str]:
    entries = [*SERVER_FILES]
    for rel_dir in SERVER_DIRS:
        entries.extend(iter_tree(root, rel_dir))
    require_files(root, entries)
    entries = sorted(dict.fromkeys(entries))
    check_forbidden(entries, SERVER_FORBIDDEN_PREFIXES, SERVER_FORBIDDEN_NAMES, "server")
    return entries


def validate_desktop_zip(output: Path) -> None:
    with zipfile.ZipFile(output, "r") as zf:
        names = set(zf.namelist())
        for required in [*DESKTOP_FILES, *DESKTOP_SCRIPTS, "bin/codex-window-point", "public/index.html"]:
            if required not in names:
                raise PackageError(f"desktop zip missing {required}")
        check_forbidden(sorted(names), DESKTOP_FORBIDDEN_PREFIXES, DESKTOP_FORBIDDEN_NAMES, "desktop")
        win = zf.read("scripts/start-windows-relay.ps1").decode("utf-8")
        mac = zf.read("scripts/start-macos-relay.sh").decode("utf-8")
        html = zf.read("public/index.html").decode("utf-8")
        if "$DefaultRegistrationKey = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'" in win:
            raise PackageError("desktop zip still has the Windows default registration key placeholder")
        if "DEFAULT_REGISTRATION_KEY='__CODEX_MINI_RELAY_REGISTRATION_KEY__'" in mac:
            raise PackageError("desktop zip still has the macOS default registration key placeholder")
        if "& $script:NpmCmd" in win:
            raise PackageError("desktop zip still calls $script:NpmCmd directly")
        if "Resolve-NpmCmd" not in win:
            raise PackageError("desktop zip is missing the npm.cmd resolver")
        if ".route-badge.is-logout" not in html or ".top-actions" not in html:
            raise PackageError("desktop zip is missing the top-actions logout button CSS")
        if "justify-content: flex-end;" not in html:
            raise PackageError("desktop zip is missing the top-actions inline alignment CSS")
        if "routeText.textContent = '';" not in html:
            raise PackageError("desktop zip must keep the logout button icon-only")
        for entry in ("start-codex-mini-relay.command", "scripts/start-macos-relay.sh", "bin/codex-window-point"):
            mode = (zf.getinfo(entry).external_attr >> 16) & 0o777
            if mode != 0o755:
                raise PackageError(f"{entry} mode is {oct(mode)}, expected 0o755")


def validate_server_zip(output: Path) -> None:
    with zipfile.ZipFile(output, "r") as zf:
        names = set(zf.namelist())
        for required in ["package.json", "package-lock.json", "relay-server/server.js", "relay-server/install-systemd.sh"]:
            if required not in names:
                raise PackageError(f"server zip missing {required}")
        check_forbidden(sorted(names), SERVER_FORBIDDEN_PREFIXES, SERVER_FORBIDDEN_NAMES, "server")
        for entry in ("relay-server/install-full.sh", "relay-server/install-systemd.sh"):
            mode = (zf.getinfo(entry).external_attr >> 16) & 0o777
            if mode != 0o755:
                raise PackageError(f"{entry} mode is {oct(mode)}, expected 0o755")


def build_desktop(args: argparse.Namespace, root: Path) -> Path:
    output = Path(args.output or root / DESKTOP_OUTPUT)
    if not output.is_absolute():
        output = root / output
    key = registration_key(args)
    write_zip(root, output, desktop_entries(root), key)
    validate_desktop_zip(output)
    return output


def build_server(args: argparse.Namespace, root: Path) -> Path:
    output = Path(args.output or root / SERVER_OUTPUT)
    if not output.is_absolute():
        output = root / output
    write_zip(root, output, server_entries(root))
    validate_server_zip(output)
    return output


def build_all(args: argparse.Namespace, root: Path) -> list[Path]:
    desktop_args = argparse.Namespace(**vars(args))
    desktop_args.output = args.desktop_output
    server_args = argparse.Namespace(**vars(args))
    server_args.output = args.server_output
    return [build_desktop(desktop_args, root), build_server(server_args, root)]


def add_key_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--registration-key", help="registration key to inject into desktop package copies")
    parser.add_argument("--env-file", help="env file containing CODEX_MINI_RELAY_REGISTRATION_KEY")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Build Codex Mini release zip artifacts.")
    sub = parser.add_subparsers(dest="command", required=True)

    desktop = sub.add_parser("desktop", help=f"build {DESKTOP_OUTPUT}")
    desktop.add_argument("--output", default=DESKTOP_OUTPUT)
    add_key_args(desktop)

    server = sub.add_parser("server", help=f"build {SERVER_OUTPUT}")
    server.add_argument("--output", default=SERVER_OUTPUT)

    all_cmd = sub.add_parser("all", help="build desktop and server zips")
    all_cmd.add_argument("--desktop-output", default=DESKTOP_OUTPUT)
    all_cmd.add_argument("--server-output", default=SERVER_OUTPUT)
    add_key_args(all_cmd)

    args = parser.parse_args(argv)
    root = repo_root()
    try:
        if args.command == "desktop":
            outputs = [build_desktop(args, root)]
        elif args.command == "server":
            outputs = [build_server(args, root)]
        elif args.command == "all":
            outputs = build_all(args, root)
        else:
            raise PackageError(f"unknown command: {args.command}")
    except PackageError as error:
        print(f"package error: {error}", file=sys.stderr)
        return 1

    for output in outputs:
        print(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
