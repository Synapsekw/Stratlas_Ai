"""A local-inertial 2D shallow-water model for direct rainfall (M11 decision 3), written from Bates,
Horritt and Fewtrell (2010), "A simple inertial formulation of the shallow water equations for
efficient two-dimensional flood inundation modelling", Journal of Hydrology 387.

State: water depth ``h`` per cell and unit-width discharge ``q`` (m²/s) per cell face. Each step:

1. ``dt = alpha dx / sqrt(g max h)`` (alpha 0.7, the paper's stability criterion), with the flow
   speed added to the wave speed where water runs fast (sheet flow on slopes), capped at ``DT_MAX``
   and at the next rainfall change or output time.
2. Every face between two cells with data, with the flow depth ``hf = max(eta) - max(z)`` (eta the
   water surface), gets the paper's semi-implicit update
   ``q = (q' - g hf dt d(eta)/dx) / (1 + g dt n² |q| / hf^(7/3))``, where ``q'`` weights the face's
   own discharge against its two neighbours along the flow (theta 0.7; de Almeida, Bates, Freer and
   Souvignet 2012, "Improving the stability of a simple formulation of the shallow water
   equations for 2-D flood modeling"), capped at Froude 0.8 (the scheme is for subcritical flow);
   faces with ``hf`` under ``H_MIN`` carry nothing.
3. **Edges** (the grid's border and faces to cells without data) are free outfalls: a cell whose bed
   falls towards the edge (the slope ``S`` from the cell behind it) discharges the normal-depth
   flow ``h^(5/3) S^(1/2) / n``; a level or rising bed is a wall. Water never enters.
4. Outflows from a cell are scaled down when they would take more water than it holds (mass is
   conserved exactly), then ``h += dt (net inflow / dx + rain)`` and the constant infiltration is
   taken, never more than the water there.

Rain and infiltration are in metres per second here; the volumes of rain, infiltration, outflow
and storage are counted every step, so the mass balance is reported with the run. CPU, float64
numpy: about 25 array operations per step.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

G = 9.81
ALPHA = 0.7
#: Faces with a smaller flow depth (metres) carry nothing.
H_MIN = 1e-4
#: The longest step (seconds), for the first steps on dry ground.
DT_MAX = 10.0
#: Discharge at a face is capped at this Froude number: the scheme is for subcritical flow, and
#: the cap keeps shallow sheet flow on steep slopes from oscillating.
FROUDE_MAX = 0.8
#: de Almeida et al. (2012) weighting of a face's own discharge against its two neighbours.
THETA = 0.7


@dataclass
class Totals:
    rain: float = 0.0
    infiltrated: float = 0.0
    outflow: float = 0.0
    steps: int = 0
    #: (time s, outflow m³/s averaged since the last sample)
    samples: list[tuple[float, float]] = field(default_factory=list)


class InertialModel:
    """The model on heights ``z`` (row 0 south, NaN no data) of cell ``dx`` metres."""

    def __init__(self, z: np.ndarray, dx: float, manning_n: float, infiltration_m_s: float):
        self.dx = float(dx)
        self.n = float(manning_n)
        self.f = float(infiltration_m_s)
        ny, nx = z.shape
        self.valid = np.isfinite(z)
        self.z = np.where(self.valid, z, 0.0)
        self.h = np.zeros((ny, nx))
        self.qx = np.zeros((ny, nx + 1))
        self.qy = np.zeros((ny + 1, nx))
        self.t = 0.0
        self.totals = Totals()
        self._since_sample = 0.0
        self._sample_t0 = 0.0
        self._setup_faces()

    def _setup_faces(self) -> None:
        v, z, dx = self.valid, self.z, self.dx
        ny, nx = v.shape
        pv = np.zeros((ny + 2, nx + 2), bool)
        pv[1:-1, 1:-1] = v
        pz = np.zeros((ny + 2, nx + 2))
        pz[1:-1, 1:-1] = z
        # x faces: left cell pv[1:-1, :-1], right cell pv[1:-1, 1:]
        lv, rv = pv[1:-1, :-1], pv[1:-1, 1:]
        self.x_inner = lv & rv
        self.x_out_r = lv & ~rv  # water leaves east through the face (q > 0)
        self.x_out_l = ~lv & rv  # water leaves west (q < 0)
        lz, rz = pz[1:-1, :-1], pz[1:-1, 1:]
        # bed slope towards the edge, from the cell behind the edge cell
        behind_l = np.zeros((ny, nx + 1))
        behind_l[:, 1:] = pz[1:-1, :-2]  # for x_out_r: the cell west of the edge cell
        behind_ok_l = np.zeros((ny, nx + 1), bool)
        behind_ok_l[:, 1:] = pv[1:-1, :-2]
        behind_r = np.zeros((ny, nx + 1))
        behind_r[:, :-1] = pz[1:-1, 2:]  # for x_out_l: the cell east of the edge cell
        behind_ok_r = np.zeros((ny, nx + 1), bool)
        behind_ok_r[:, :-1] = pv[1:-1, 2:]
        self.x_slope_r = np.where(self.x_out_r & behind_ok_l, np.maximum((behind_l - lz) / dx, 0.0), 0.0)
        self.x_slope_l = np.where(self.x_out_l & behind_ok_r, np.maximum((behind_r - rz) / dx, 0.0), 0.0)
        # y faces: south cell pv[:-1, 1:-1], north cell pv[1:, 1:-1]
        sv, nv = pv[:-1, 1:-1], pv[1:, 1:-1]
        self.y_inner = sv & nv
        self.y_out_n = sv & ~nv
        self.y_out_s = ~sv & nv
        sz, nz = pz[:-1, 1:-1], pz[1:, 1:-1]
        behind_s = np.zeros((ny + 1, nx))
        behind_s[1:, :] = pz[:-2, 1:-1]
        behind_ok_s = np.zeros((ny + 1, nx), bool)
        behind_ok_s[1:, :] = pv[:-2, 1:-1]
        behind_n = np.zeros((ny + 1, nx))
        behind_n[:-1, :] = pz[2:, 1:-1]
        behind_ok_n = np.zeros((ny + 1, nx), bool)
        behind_ok_n[:-1, :] = pv[2:, 1:-1]
        self.y_slope_n = np.where(self.y_out_n & behind_ok_s, np.maximum((behind_s - sz) / dx, 0.0), 0.0)
        self.y_slope_s = np.where(self.y_out_s & behind_ok_n, np.maximum((behind_n - nz) / dx, 0.0), 0.0)

    # -------------------------------------------------------------------------------- one step

    def max_dt(self) -> float:
        hmax = float(self.h.max()) if self.h.size else 0.0
        if hmax <= H_MIN:
            return DT_MAX
        speed = math.sqrt(G * hmax)
        # the flow's own speed too, where it is not small against the wave speed (slopes)
        hf = np.maximum(self.h, H_MIN)
        ux = np.maximum(np.abs(self.qx[:, :-1]), np.abs(self.qx[:, 1:])) / hf
        uy = np.maximum(np.abs(self.qy[:-1, :]), np.abs(self.qy[1:, :])) / hf
        wet = self.h > H_MIN
        if wet.any():
            speed = max(speed, float(np.max((np.maximum(ux, uy) + np.sqrt(G * self.h))[wet])))
        return min(DT_MAX, ALPHA * self.dx / speed)

    def step(self, dt: float, rain_m_s: float) -> None:
        dx, n2 = self.dx, self.n * self.n
        h, z = self.h, self.z
        ny, nx = h.shape
        # padded views of h, z, eta for the faces
        ph = np.zeros((ny + 2, nx + 2))
        ph[1:-1, 1:-1] = h
        pz = np.zeros((ny + 2, nx + 2))
        pz[1:-1, 1:-1] = z
        pe = pz + ph
        # x faces
        el, er = pe[1:-1, :-1], pe[1:-1, 1:]
        zl, zr = pz[1:-1, :-1], pz[1:-1, 1:]
        hf = np.maximum(el, er) - np.maximum(zl, zr)
        q = self.qx
        if THETA < 1:
            q = self.qx.copy()
            q[:, 1:-1] = THETA * self.qx[:, 1:-1] + (1 - THETA) / 2 * (self.qx[:, :-2] + self.qx[:, 2:])
        with np.errstate(divide="ignore", invalid="ignore"):
            upd = (q - G * hf * dt * (er - el) / dx) / (
                1 + G * dt * n2 * np.abs(q) / np.power(np.maximum(hf, H_MIN), 7 / 3)
            )
        qx = np.where(self.x_inner & (hf > H_MIN), upd, 0.0)
        cap = FROUDE_MAX * hf * np.sqrt(G * np.maximum(hf, 0.0))
        qx = np.clip(qx, -cap, cap)
        hl, hr = ph[1:-1, :-1], ph[1:-1, 1:]
        qx = np.where(self.x_out_r, np.power(hl, 5 / 3) * np.sqrt(self.x_slope_r) / self.n, qx)
        qx = np.where(self.x_out_l, -np.power(hr, 5 / 3) * np.sqrt(self.x_slope_l) / self.n, qx)
        # y faces
        es, en = pe[:-1, 1:-1], pe[1:, 1:-1]
        zs, zn = pz[:-1, 1:-1], pz[1:, 1:-1]
        hf = np.maximum(es, en) - np.maximum(zs, zn)
        q = self.qy
        if THETA < 1:
            q = self.qy.copy()
            q[1:-1, :] = THETA * self.qy[1:-1, :] + (1 - THETA) / 2 * (self.qy[:-2, :] + self.qy[2:, :])
        with np.errstate(divide="ignore", invalid="ignore"):
            upd = (q - G * hf * dt * (en - es) / dx) / (
                1 + G * dt * n2 * np.abs(q) / np.power(np.maximum(hf, H_MIN), 7 / 3)
            )
        qy = np.where(self.y_inner & (hf > H_MIN), upd, 0.0)
        cap = FROUDE_MAX * hf * np.sqrt(G * np.maximum(hf, 0.0))
        qy = np.clip(qy, -cap, cap)
        hs, hn = ph[:-1, 1:-1], ph[1:, 1:-1]
        qy = np.where(self.y_out_n, np.power(hs, 5 / 3) * np.sqrt(self.y_slope_n) / self.n, qy)
        qy = np.where(self.y_out_s, -np.power(hn, 5 / 3) * np.sqrt(self.y_slope_s) / self.n, qy)
        # limit outflows to the water a cell holds (plus this step's rain)
        out = (
            (
                np.maximum(qx[:, 1:], 0)
                + np.maximum(-qx[:, :-1], 0)
                + np.maximum(qy[1:, :], 0)
                + np.maximum(-qy[:-1, :], 0)
            )
            * dt
            / dx
        )
        avail = h + rain_m_s * dt * self.valid
        with np.errstate(divide="ignore", invalid="ignore"):
            fac = np.where(out > avail, avail / out, 1.0)
        fac = np.where(np.isfinite(fac), fac, 0.0)
        pf = np.ones((ny + 2, nx + 2))
        pf[1:-1, 1:-1] = fac
        qx = np.where(qx > 0, qx * pf[1:-1, :-1], qx * pf[1:-1, 1:])
        qy = np.where(qy > 0, qy * pf[:-1, 1:-1], qy * pf[1:, 1:-1])
        self.qx, self.qy = qx, qy
        # continuity
        div = (qx[:, :-1] - qx[:, 1:] + qy[:-1, :] - qy[1:, :]) / dx
        h = h + dt * (div + rain_m_s * self.valid)
        h = np.where(self.valid, np.maximum(h, 0.0), 0.0)
        inf = np.minimum(self.f * dt, h) if self.f > 0 else 0.0
        h = h - inf
        self.h = h
        # bookkeeping (volumes, m³)
        a = dx * dx
        ncell = int(self.valid.sum())
        self.totals.rain += rain_m_s * dt * a * ncell
        self.totals.infiltrated += float(np.sum(inf)) * a if self.f > 0 else 0.0
        edge = (
            np.sum(qx[self.x_out_r])
            - np.sum(qx[self.x_out_l])
            + np.sum(qy[self.y_out_n])
            - np.sum(qy[self.y_out_s])
        )
        vol_out = float(edge) * dt * dx
        self.totals.outflow += vol_out
        self._since_sample += vol_out
        self.totals.steps += 1
        self.t += dt

    def sample(self) -> float:
        """The mean outflow (m³/s) since the last sample, recorded with the time."""
        span = self.t - self._sample_t0
        rate = self._since_sample / span if span > 0 else 0.0
        self.totals.samples.append((self.t, rate))
        self._since_sample = 0.0
        self._sample_t0 = self.t
        return rate

    @property
    def stored(self) -> float:
        return float(self.h.sum()) * self.dx * self.dx


def run(
    model: InertialModel,
    rain_at: Callable[[float], float],
    events: list[float],
    end: float,
    on_event: Callable[[float], None],
    check: Callable[[], None] = lambda: None,
) -> None:
    """Advance to ``end`` seconds, landing exactly on each time in ``events`` (rainfall changes and
    outputs) and calling ``on_event`` there."""
    todo = sorted({t for t in events if 0 < t <= end} | {end})
    k = 0
    while k < len(todo):
        target = todo[k]
        while model.t < target - 1e-9:
            dt = min(model.max_dt(), target - model.t)
            model.step(dt, rain_at(model.t + dt / 2))
            if model.totals.steps % 64 == 0:
                check()
        on_event(target)
        k += 1
