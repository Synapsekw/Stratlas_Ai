"""``native.find_tool`` for the thermal tools: ExifTool and the DJI Thermal SDK folder."""

from __future__ import annotations

import os

from aio_pipelines.photo import native

EXE = "exiftool.exe" if os.name == "nt" else "exiftool"
LIB = "libdirp.dll" if os.name == "nt" else "libdirp.so"


def test_thermal_tools_are_registered():
    assert native.TOOLS["exiftool"] == ("QUADRION_EXIFTOOL", "exiftool")
    assert native.TOOLS["dji_tsdk"] == ("QUADRION_DJI_TSDK", "dji-tsdk")


def test_exiftool_is_found_by_its_variable_and_in_the_pack(tmp_path, monkeypatch):
    monkeypatch.delenv("QUADRION_EXIFTOOL", raising=False)
    exe = tmp_path / "tools" / "exiftool" / EXE
    exe.parent.mkdir(parents=True)
    exe.write_bytes(b"")
    monkeypatch.setattr(native.sys, "prefix", str(tmp_path / "python"))
    assert native.find_tool("exiftool") == str(exe)
    other = tmp_path / "other.exe"
    other.write_bytes(b"")
    monkeypatch.setenv("QUADRION_EXIFTOOL", str(other))
    assert native.find_tool("exiftool") == str(other)
    monkeypatch.setenv("QUADRION_EXIFTOOL", str(tmp_path / "missing.exe"))
    assert native.find_tool("exiftool") is None


def test_dji_tsdk_is_the_folder_holding_the_library(tmp_path, monkeypatch):
    monkeypatch.delenv("QUADRION_DJI_TSDK", raising=False)
    monkeypatch.setattr(native.sys, "prefix", str(tmp_path / "python"))
    assert native.find_tool("dji_tsdk") is None
    sdk = tmp_path / "sdk"
    sdk.mkdir()
    monkeypatch.setenv("QUADRION_DJI_TSDK", str(sdk))
    assert native.find_tool("dji_tsdk") is None  # a folder without the library
    (sdk / LIB).write_bytes(b"")
    assert native.find_tool("dji_tsdk") == str(sdk)
    monkeypatch.setenv("QUADRION_DJI_TSDK", str(sdk / LIB))  # the library itself also names it
    assert native.find_tool("dji_tsdk") == str(sdk)
    monkeypatch.delenv("QUADRION_DJI_TSDK")
    pack = tmp_path / "tools" / "dji-tsdk"
    pack.mkdir(parents=True)
    (pack / LIB).write_bytes(b"")
    assert native.find_tool("dji_tsdk") == str(pack)
