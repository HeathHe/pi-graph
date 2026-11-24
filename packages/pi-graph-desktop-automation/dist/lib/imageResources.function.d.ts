/// <reference types="node" preserve="true" />
import { URL } from "url";
import { Image } from "pi-graph-desktop-shared";
import { ProviderRegistry } from "pi-graph-desktop-provider-api";
export declare function loadImageResource(providerRegistry: ProviderRegistry, resourceDirectory: string, fileName: string): Promise<Image>;
/**
 * fetchFromUrl loads remote image content at runtime to provide it for further use in on-screen image search
 * @param url The remote URl to fetch an image from as string or {@link URL}
 * @throws On malformed URL input or in case of non-image remote content
 */
export declare function fetchFromUrl(url: string | URL): Promise<Image>;
