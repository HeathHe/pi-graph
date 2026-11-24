import { MovementApi } from "./movement-api.interface";
import { LineHelper } from "./util/linehelper.class";
import { ProviderRegistry } from "pi-graph-desktop-provider-api";
export declare const createMovementApi: (providerRegistry: ProviderRegistry, lineHelper: LineHelper) => MovementApi;
