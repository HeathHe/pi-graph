import { Image, Point, RGBA } from "pi-graph-desktop-shared";
import { ImageProcessor } from "pi-graph-desktop-provider-api";
export default class implements ImageProcessor {
    colorAt(image: Image | Promise<Image>, point: Point | Promise<Point>): Promise<RGBA>;
}
