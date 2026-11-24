import { MouseClass } from "../../mouse.class";
import { Point } from "pi-graph-desktop-shared";
export declare const toBeAt: (received: MouseClass, position: Point) => Promise<{
    message: () => string;
    pass: boolean;
}>;
