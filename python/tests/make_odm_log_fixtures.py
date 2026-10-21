"""Write the two synthetic ODM console logs that test_odm_sfm_progress.py reads.

Run from anywhere: ``python make_odm_log_fixtures.py``. The lines follow the formats ODM 3.6.2
prints for its OpenSfM stage; photo names, paths, dates and numbers are made up.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).parent / "fixtures" / "odm_log"
BIN = r"C:\odm\SuperBuild\install\bin\opensfm\bin\opensfm"
WORK = r"C:\odm-work\project\opensfm"
GREEN = "\x1b[32m"
RESET = "\x1b[0m"


def stamp(t: datetime) -> str:
    return t.strftime("%Y-%m-%d %H:%M:%S,") + f"{t.microsecond // 1000:03d}"


def running(cmd: str, extra: str = "") -> str:
    return f'[INFO]    running "{BIN}" {cmd}{extra} "{WORK}"'


def first_run() -> list[str]:
    t = datetime(2026, 1, 1, 14, 8, 33)
    out = [
        "[INFO]    Running dataset stage",
        r"[INFO]    Loading dataset from: C:\odm-work\project\images",
        "[INFO]    Loading 1003 images",
        "[INFO]    Found 1003 usable images",
        "[INFO]    Finished dataset stage",
        "[INFO]    Running split stage",
        "[INFO]    Normal dataset, will process all at once.",
        "[INFO]    Finished split stage",
        "[INFO]    Running merge stage",
        "[INFO]    Finished merge stage",
        "[INFO]    Running opensfm stage",
        "[INFO]    Writing exif overrides",
        f"{GREEN}[INFO]    Using the camera model from the first photo{RESET}",
        running("detect_features"),
    ]
    for i in range(20):
        t += timedelta(milliseconds=250)
        out.append(f"{stamp(t)} INFO: Extracting ROOT_SIFT_GPU features for image {i * 7 + 1:05d}.jpg")
        if i == 9:
            out.append(f"{stamp(t)} INFO: Loading the feature extraction settings")
    out.append(running("match_features"))
    t += timedelta(seconds=3)
    out.append(f"{stamp(t)} INFO: Matching 12467 image pairs")
    for i in range(48):
        t += timedelta(milliseconds=500)
        a, b = i * 13 + 1, i * 13 + 4
        out.append(
            f"{stamp(t)} DEBUG: Matching {a:05d}.jpg and {b:05d}.jpg.  Matcher: FLANN (symmetric) "
            "T-desc: 1.009 T-robust: 0.000 T-total: 1.010 Matches: 143 Robust: 132 Success: True"
        )
    out.append(running("create_tracks"))
    t += timedelta(seconds=4)
    out.append(f"{stamp(t)} INFO: reading features")
    out.append(running("reconstruct"))
    t += timedelta(seconds=2)
    out.append(f"{stamp(t)} INFO: Starting reconstruction with 00430.jpg and 00431.jpg")
    for i in range(28):
        t += timedelta(seconds=2)
        out.append(f"{stamp(t)} INFO: Adding {432 + i:05d}.jpg to the reconstruction")
        if i == 14:
            out.append(f"{stamp(t)} INFO: Shots and/or GCPs are well-conditioned.")
    out.append(f"{stamp(t)} INFO: Shots and/or GCPs are well-conditioned. Using naive 3D-3D alignment.")
    return out


def resumed_run() -> list[str]:
    start = datetime(2026, 1, 1, 16, 8, 40, 978000)
    quiet_before = datetime(2026, 1, 1, 16, 46, 13, 380000)
    quiet_after = datetime(2026, 1, 1, 16, 52, 39, 944000)
    out = [
        "[INFO]    Running dataset stage",
        r"[INFO]    Loading images database: C:\odm-work\project\images.json",
        "[INFO]    Found 1003 usable images",
        "[INFO]    Finished dataset stage",
        "[INFO]    Running opensfm stage",
        r"[WARNING] C:\odm-work\project\opensfm\image_list.txt already exists, not rerunning OpenSfM setup",
        r"[WARNING] C:\odm-work\project\opensfm\exif already exists, not rerunning photo to metadata",
        r"[WARNING] Detect features already done: C:\odm-work\project\opensfm\features exists",
        r"[WARNING] Match features already done: C:\odm-work\project\opensfm\matches exists",
        r"[WARNING] Found a valid OpenSfM tracks file in: C:\odm-work\project\opensfm\tracks.csv",
        f"{GREEN}[INFO]    Reconstruction settings are unchanged{RESET}",
        running("reconstruct"),
        f"{stamp(start - timedelta(seconds=1))} INFO: reading tracks",
        f"{stamp(start)} INFO: Starting reconstruction with 00430.jpg and 00431.jpg",
    ]
    # 73 distinct photos, one of them reported twice; the long silent adjustment sits
    # between the 40th and 41st.
    step_a = (quiet_before - start) / 40
    step_b = timedelta(seconds=20)
    for i in range(73):
        t = start + step_a * (i + 1) if i < 40 else quiet_after + step_b * (i - 40)
        out.append(f"{stamp(t)} INFO: Adding {i + 1:05d}.jpg to the reconstruction")
        if i == 20:
            out.append(f"{stamp(t)} INFO: Adding {i + 1:05d}.jpg to the reconstruction")
        if i == 55:
            out.append(f"{stamp(t)} INFO: Running a bundle adjustment on the current model")
    out += [
        "[INFO]    Export reconstruction stats",
        running("compute_statistics", " --diagram_max_points 100000"),
        running(
            "export_geocoords",
            ' --reconstruction --proj "+proj=utm +zone=1 +datum=WGS84 +units=m +no_defs"'
            " --offset-x 0.0 --offset-y 0.0",
        ),
        r"[INFO]    Undistorting C:\odm-work\project\opensfm ...",
        running("export_visualsfm", " --points"),
        running("export_ply", " --no-cameras --point-num-views"),
        "[INFO]    Finished opensfm stage",
    ]
    return out


def main() -> None:
    for name, lines in (("first-run.txt", first_run()), ("resumed-run.txt", resumed_run())):
        (HERE / name).write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
