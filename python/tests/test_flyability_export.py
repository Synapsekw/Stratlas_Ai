"""The Flyability Inspector export reader: links, backups, transforms, privacy, gaps."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import numpy as np

from aio_pipelines.flyability.export import read_export, read_trajectory
from flyability_synth import EMAIL, LAUNCH_LAT, YAW_20_SHIFT, SynthExport, make_export


def _flights(export):
    return export.inspections[0].flights


def test_reads_links(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "x")
    export = read_export(syn.root)
    assert export.asset_name == "Synthetic chamber"
    assert export.generation == "2025-mcap"
    assert len(export.inspections) == 1
    insp = export.inspections[0]
    assert insp.id == syn.inspection_id
    assert insp.name == "Synthetic room"
    assert insp.merged_cloud is not None and insp.merged_cloud.name == "inspection_map2.las"
    assert insp.merged_cloud.is_file()
    assert [f.id for f in insp.flights] == syn.flight_ids
    assert [p.name for p in insp.pois] == ["POI-1", "POI-2", "POI-3"]
    assert [len(p.snapshots) for p in insp.pois] == [1, 2, 1]
    assert [s.id for p in insp.pois for s in p.snapshots] == syn.snapshot_ids
    snap = insp.pois[0].snapshots[0]
    assert snap.flight_id == syn.flight_ids[1]
    assert snap.criticality == "High" and snap.tags == ["corrosion"]
    assert snap.photo is not None and snap.photo.name.endswith("_rgb.jpg")
    assert snap.annotated is not None and snap.annotated.name == "result_annotated.jpg"
    assert snap.points == [(0.5, 0.4, "rust patch")]
    assert snap.image_size == (8, 6)
    assert snap.folder.name == snap.id
    assert snap.camera_q.shape == (4,) and snap.camera_pos.shape == (3,)
    assert insp.pois[0].tags == ["corrosion"]
    assert insp.pois[0].description == ""


def test_ignores_backups(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "x")
    insp = read_export(syn.root).inspections[0]
    assert insp.name == "Synthetic room"
    assert [f.name for f in insp.flights] == ["Flight #1", "Flight #2"]
    assert _flights_b_transform_ok(insp)
    low, crit = insp.pois[1].snapshots
    assert (low.criticality, low.comment) == ("Low", "finding 2")
    assert crit.criticality == "Critical"
    assert crit.wall_distance is not None and crit.wall_distance < 90
    assert insp.pois[2].snapshots[0].wall_distance is None
    assert all(p.name.startswith("POI-") for p in insp.pois)


def _flights_b_transform_ok(insp) -> bool:
    return insp.flights[1].transform is not None


def test_transform_row_major(tmp_path: Path) -> None:
    flights = _flights(read_export(make_export(tmp_path / "x").root))
    a, b = flights
    assert a.transform is None and a.relocalised is True
    assert b.relocalised is False
    assert b.transform is not None and b.transform.shape == (4, 4)
    assert np.allclose(b.transform[:3, 3], (0.4, -0.3, 0.05))
    assert np.allclose(b.transform, np.array(YAW_20_SHIFT).reshape(4, 4))
    assert a.datetime_utc is not None and b.datetime_utc == a.datetime_utc + 100


def test_flight_clouds_and_trajectories(tmp_path: Path) -> None:
    flights = _flights(read_export(make_export(tmp_path / "x").root))
    for f in flights:
        assert f.cloud is not None and f.cloud.name.endswith("_livemap.las")
        assert f.trajectory is not None and f.trajectory.name.endswith("_livetraj.csv")


def test_no_private_fields(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "x")
    text = repr(read_export(syn.root))
    assert EMAIL not in text
    assert "12.3456789" not in text and str(LAUNCH_LAT) not in text
    assert "45.6789012" not in text and "321.5" not in text


def test_both_generations(tmp_path: Path) -> None:
    new = read_export(make_export(tmp_path / "new", generation="2025").root)
    old = read_export(make_export(tmp_path / "old", generation="2024").root)
    assert old.generation == "2024-bag" and new.generation == "2025-mcap"
    assert old.inspections[0].merged_cloud.name == "inspection_map1.las"
    assert [len(p.snapshots) for p in old.inspections[0].pois] == [1, 2, 1]
    assert len(old.inspections[0].flights) == 2
    assert all(s.criticality is None for p in old.inspections[0].pois for s in p.snapshots)


def test_trajectory_columns(tmp_path: Path) -> None:
    flight = _flights(read_export(make_export(tmp_path / "x").root))[0]
    traj = read_trajectory(flight.trajectory)
    assert traj.shape[1] == 8 and traj.shape[0] > 10
    assert np.all(np.diff(traj[:, 0]) >= 0)
    assert np.allclose(np.linalg.norm(traj[:, 4:8], axis=1), 1.0, atol=1e-5)
    # unsorted input comes back sorted
    shuffled = tmp_path / "t.csv"
    lines = flight.trajectory.read_text().splitlines()
    shuffled.write_text("\n".join([lines[0], *reversed(lines[1:])]) + "\n")
    assert np.all(np.diff(read_trajectory(shuffled)[:, 0]) >= 0)


def test_missing_parts(tmp_path: Path) -> None:
    syn: SynthExport = make_export(tmp_path / "x", merged=False)
    # drop flight A's map, and the first POI record
    for mj in (syn.root / "maps").glob("*/map.json"):
        data = json.loads(mj.read_text())
        if data["parent_id"] == syn.flight_ids[0]:
            shutil.rmtree(mj.parent)
    shutil.rmtree(syn.root / "pois" / syn.poi_ids[0])
    insp = read_export(syn.root).inspections[0]
    assert insp.merged_cloud is None
    assert insp.flights[0].cloud is None and insp.flights[0].trajectory is None
    assert insp.flights[1].cloud is not None
    synthetic = [p for p in insp.pois if p.id == syn.poi_ids[0]]
    assert len(synthetic) == 1
    assert synthetic[0].name == f"Snapshot {syn.snapshot_ids[0][:8]}"
    assert [s.id for s in synthetic[0].snapshots] == [syn.snapshot_ids[0]]
    assert len(insp.pois) == 3


def test_missing_asset_and_empty(tmp_path: Path) -> None:
    syn = make_export(tmp_path / "x")
    shutil.rmtree(syn.root / "assets")
    assert read_export(syn.root).asset_name is None
