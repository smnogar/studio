// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PNG } from "pngjs";
import * as THREE from "three";
import URDFLoader from "urdf-loader";
import UTIF from "utif";
import { XacroParser } from "xacro-parser";

import Logger from "@foxglove/log";
import {
  AssetLoader,
  Asset,
  parsePackageUrl,
  rewritePackageUrl,
} from "@foxglove/studio-base/context/AssetsContext";
import isDesktopApp from "@foxglove/studio-base/util/isDesktopApp";

const log = Logger.getLogger(__filename);

const URDF_ROOT = "$URDF_ROOT";

class TiffLoader extends THREE.Loader {
  constructor(manager: THREE.LoadingManager) {
    super(manager);
  }

  override async loadAsync(url: string): Promise<HTMLImageElement> {
    const image = document.createElement("img");

    const res = await fetch(url);
    const blob = await res.blob();
    image.src = URL.createObjectURL(blob);

    /*
    const [ifd] = UTIF.decode(buf);
        if (!ifd) {
          throw new Error("TIFF decoding failed");
        }
        UTIF.decodeImage(buf, ifd);
        const png = new PNG({ width: ifd.width, height: ifd.height });
        png.data = Buffer.from(UTIF.toRGBA8(ifd));
        const pngData = PNG.sync.write(png);
        */

    return image;
  }
}

export default class URDFAssetLoader implements AssetLoader {
  async load(
    file: File,
    { basePath }: { basePath: string | undefined },
  ): Promise<Asset | undefined> {
    if (!/\.(urdf|xacro|xml)$/.test(file.name)) {
      return undefined;
    }
    const text = await file.text();
    if (text.trim().length === 0) {
      throw new Error(`${file.name} is empty`);
    }

    const xacroParser = new XacroParser();
    xacroParser.rospackCommands = {
      // Translate find commands to `package://` URLs, which makes the XacroParser treat them as
      // absolute paths.
      find: (targetPkg) => `package://${targetPkg}`,
    };
    xacroParser.getFileContents = async (path: string) => {
      console.error("get file content", path);
      // Given a fully formed package:// URL, translate it to something we can actually fetch.
      if (!parsePackageUrl(path)) {
        throw new Error(`Unable to get file contents for ${path}`);
      }
      const url = rewritePackageUrl(path, { basePath });
      try {
        return await (await fetch(url)).text();
      } catch (err) {
        console.error("erro", { err });
        throw err;
      }
    };

    const urdf = await xacroParser.parse(text);
    if (urdf.getElementsByTagName("parsererror").length !== 0) {
      throw new Error(`${file.name} could not be parsed as XML`);
    }
    log.info("Parsing URDF", urdf);

    const manager = new THREE.LoadingManager();

    manager.addHandler(/\.tiff?$/i, new TiffLoader(manager));

    const loader = new URDFLoader(manager);
    const finishedLoading = new Promise<void>((resolve, reject) => {
      manager.onLoad = () => resolve();
      manager.onError = (url) => {
        if (/^package:\/\//.test(url)) {
          if (!isDesktopApp()) {
            reject(new Error("package:// urls require the desktop app."));
            return;
          }
          reject(
            new Error(
              `Could not resolve ${url}. Check that you've set the ROS_PACKAGE_PATH environment variable or app setting.`,
            ),
          );
          return;
        }

        reject(new Error(`Failed to load ${url}.`));
      };
    });

    // URDFLoader calls this function for every `package://` url it encounters.
    // It provides the package name and will append the resource path to the return value of this function
    // For the desktop app, we support `package://` urls so we re-make the `package://` url using
    // the package name.
    loader.packages = (targetPkg: string) => {
      return `package://${targetPkg}`;
    };

    // If there are no nested assets to load, then the LoadingManager will never emit onLoad unless
    // we tell it the top-level load has finished.
    manager.itemStart(URDF_ROOT);
    const robot = loader.parse(urdf);
    manager.itemEnd(URDF_ROOT);
    await finishedLoading;

    if (robot.children.length === 0) {
      throw new Error(`The URDF file ${file.name} contained no visual elements.`);
    }

    return { name: file.name, type: "urdf", model: robot };
  }
}
