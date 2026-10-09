/**
 * The grid path's sums (data-conventions section 26) as a small accumulator, for callers that
 * walk their own cells (the stockpile kit's 10 cm grids): `add(w, dz)` per covered cell with its
 * weight, then `result(cellArea)`. Fill sums `w dz` where `dz > 0`, cut `-w dz` where `dz < 0`,
 * and with the deadband used only cells with `|dz| >= deadband` count.
 */
export interface Accumulated {
  fill: number;
  cut: number;
  areaFill: number;
  areaCut: number;
  areaUnchanged: number;
}

export class Accumulator {
  fill = 0;
  cut = 0;
  wFill = 0;
  wCut = 0;
  wUnchanged = 0;

  constructor(
    readonly deadband = 0,
    readonly useDeadband = false,
  ) {}

  add(w: number, dz: number): void {
    const counts = !this.useDeadband || Math.abs(dz) >= this.deadband;
    if (counts && dz > 0) {
      this.fill += w * dz;
      this.wFill += w;
    } else if (counts && dz < 0) {
      this.cut -= w * dz;
      this.wCut += w;
    } else this.wUnchanged += w;
  }

  result(cellArea: number): Accumulated {
    return {
      fill: this.fill * cellArea,
      cut: this.cut * cellArea,
      areaFill: this.wFill * cellArea,
      areaCut: this.wCut * cellArea,
      areaUnchanged: this.wUnchanged * cellArea,
    };
  }
}
