import { Point, RGBA } from "pi-graph-desktop-shared";
export declare const toHaveColor: (received: Point, needle: RGBA) => Promise<{
    message: () => string;
    pass: boolean;
}>;
