import { Image } from "pi-graph-desktop-shared";
import { DataSinkInterface } from "./data-sink.interface";
export interface ImageWriterParameters {
    image: Image;
    path: string;
}
export type ImageWriter = DataSinkInterface<ImageWriterParameters, void>;
