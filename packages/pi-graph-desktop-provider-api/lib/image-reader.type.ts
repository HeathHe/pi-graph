import { DataSourceInterface } from "./data-source.interface";
import { Image } from "pi-graph-desktop-shared";

export type ImageReader = DataSourceInterface<string, Image>;
