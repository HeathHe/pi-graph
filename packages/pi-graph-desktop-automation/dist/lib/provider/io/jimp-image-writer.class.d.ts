import { ImageWriter, ImageWriterParameters } from "pi-graph-desktop-provider-api";
export default class implements ImageWriter {
    store(parameters: ImageWriterParameters): Promise<void>;
}
