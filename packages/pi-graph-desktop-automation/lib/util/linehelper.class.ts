import { Point } from "pi-graph-desktop-shared";

import { Bresenham } from "./bresenham.class";

export class LineHelper {
  constructor() {}

  public straightLine(from: Point, to: Point): Point[] {
    return Bresenham.compute(from, to);
  }
}
