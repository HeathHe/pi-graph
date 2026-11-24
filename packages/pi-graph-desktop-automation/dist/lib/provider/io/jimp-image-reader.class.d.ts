import { ImageReader } from "pi-graph-desktop-provider-api";
import { Image } from "pi-graph-desktop-shared";
export default class implements ImageReader {
    load(parameters: string): Promise<Image>;
}
