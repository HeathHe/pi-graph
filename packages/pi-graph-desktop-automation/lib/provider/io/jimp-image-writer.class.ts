// Modified by @dyw1234: Jimp 1.6.1 async write API (legacy Promise<void> preserved).
import { ImageWriter, ImageWriterParameters } from "pi-graph-desktop-provider-api";
import { imageToJimp } from "pi-graph-desktop-shared";

export default class implements ImageWriter {
  store(parameters: ImageWriterParameters): Promise<void> {
    return new Promise((resolve, reject) => {
      const jimpImage = imageToJimp(parameters.image);
      jimpImage
        .write(parameters.path as `${string}.${string}`)
        .then((_) => resolve())
        .catch((err) => reject(err));
    });
  }
}
