// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
import { DOMParser } from "@xmldom/xmldom";
import { protocol } from "electron";
import { promises as fs } from "fs";
import path from "path";

import Logger from "@foxglove/log";
import { AppSetting } from "@foxglove/studio-base/src/AppSetting";

import { getAppSetting } from "./settings";

const log = Logger.getLogger(__filename);

/** Extract a package name from a ROS package.xml file. */
function rosPackageName(packageXmlContents: string) {
  const doc = new DOMParser().parseFromString(packageXmlContents, "text/xml");
  const packageName = Array.from(
    (doc as Partial<typeof doc>).documentElement?.childNodes ?? [],
  ).find((n) => n.nodeName.toLowerCase() === "name")?.textContent;
  return packageName ?? undefined;
}

/**
 * Read package.xml from the given directory to determine if it is a ROS package. If so, return the
 * `<name/>` of the package.
 */
export async function rosPackageNameAtPath(packagePath: string): Promise<string | undefined> {
  try {
    const contents = await fs.readFile(path.join(packagePath, "package.xml"), {
      encoding: "utf-8",
    });
    return rosPackageName(contents);
  } catch (err) {
    return undefined;
  }
}

/**
 * Return a map of ROS package names to their absolute paths.
 */
async function listRosPackages(rootPath: string): Promise<Map<string, string>> {
  const packagePaths = await fs.readdir(rootPath, { withFileTypes: true });
  const packagesArray: { name: string | undefined; absolutePath: string }[] = await Promise.all(
    packagePaths.map(async (packagePath) => {
      const absolutePath = path.join(rootPath, packagePath.name);
      try {
        const name = packagePath.isDirectory()
          ? await rosPackageNameAtPath(absolutePath)
          : undefined;
        return { name, absolutePath };
      } catch (err) {
        return { name: undefined, absolutePath };
      }
    }),
  );

  const packages = new Map<string, string>();
  for (const { name, absolutePath } of packagesArray) {
    if (name != undefined) {
      packages.set(name, absolutePath);
    }
  }
  return packages;
}

/**
 * Search for a ROS package.
 *
 * The search algorithm attempts to find the package in this order. It stops as soon as the package
 * is found:
 * - If options.searchPath is set, this folder and all of its parents are searched for the package
 * - If options.rosPackagePath is set, this folder(s) are searched
 * - If env.ROS_PACKAGE_PATH is available, this folder(s) are searched
 *
 * https://wiki.ros.org/ROS/EnvironmentVariables#ROS_PACKAGE_PATH
 */
export async function findRosPackageRoot(
  pkg: string,
  options?: { rosPackagePath?: string; searchPath?: string },
): Promise<string | undefined> {
  const { searchPath } = options ?? {};
  // log.debug(`findRosPackageRoot(${pkg}, ${rosPackagePath}, ${searchPath})`);

  const triedPaths: string[] = [];

  // Search searchPath and all parent paths
  if (searchPath != undefined) {
    let currentPath = searchPath;
    for (;;) {
      triedPaths.push(currentPath);
      if ((await rosPackageNameAtPath(currentPath)) === pkg) {
        // log.debug(`Found ROS package ${pkg} at ${currentPath} (searched relative to ${searchPath})`);
        return currentPath;
      }
      if (path.dirname(currentPath) === currentPath) {
        break;
      }
      currentPath = path.dirname(currentPath);
    }
  }

  // Search options.rosPackagePath
  if (options?.rosPackagePath) {
    const rosPackagePaths = options.rosPackagePath.split(path.delimiter);
    for (const rosPackagePath of rosPackagePaths) {
      triedPaths.push(rosPackagePath);
      const packages = await listRosPackages(rosPackagePath);
      const packagePath = packages.get(pkg);
      if (packagePath) {
        // log.info(`Found ROS package "${pkg}" at "${packagePath}" (in ROS_PACKAGE_PATH "${ROS_PACKAGE_PATH}")`);
        return packagePath;
      }
    }
  }

  // Search env.ROS_PACKAGE_PATH
  if (process.env.ROS_PACKAGE_PATH) {
    const rosPackagePaths = process.env.ROS_PACKAGE_PATH.split(path.delimiter);
    for (const rosPackagePath of rosPackagePaths) {
      triedPaths.push(rosPackagePath);
      const packages = await listRosPackages(rosPackagePath);
      const packagePath = packages.get(pkg);
      if (packagePath) {
        // log.info(`Found ROS package "${pkg}" at "${packagePath}" (in ROS_PACKAGE_PATH "${ROS_PACKAGE_PATH}")`);
        return packagePath;
      }
    }
  }

  log.warn(`Could not find ROS package "${pkg}" in: ${triedPaths.join(path.delimiter)}`);
  return undefined;
}

// https://source.chromium.org/chromium/chromium/src/+/master:net/base/net_error_list.h
const NET_ERROR_FAILED = -2;

/**
 * Register handlers for package: protocol
 * These URLs contain parameters for the ROS package name, the resource name relative to
 * the package root, and a search path (the path to the URDF file itself, when the file was dropped
 * in). We use the given search path and/or `env.ROS_PACKAGE_PATH` to locate the resource files.
 *
 * The -converted-tiff: protocol reads TIFF images and converts them to PNG before sending the
 * response, because Chromium doesn't support TIFFs. The urdf_tutorial examples use .tif textures on
 * their meshes.
 */
export function registerRosPackageProtocolHandlers(): void {
  protocol.registerFileProtocol("package", async (request, callback) => {
    try {
      const rosPackagePath =
        getAppSetting<string>(AppSetting.ROS_PACKAGE_PATH) ?? process.env.ROS_PACKAGE_PATH;

      if (!rosPackagePath) {
        throw new Error("ROS_PACKAGE_PATH not set");
      }

      const url = new URL(request.url);
      const targetPkg = url.host;
      const relPath = url.pathname;

      const pkgRoot = await findRosPackageRoot(targetPkg, {
        rosPackagePath,
      });

      if (!pkgRoot) {
        throw new Error(
          `ROS package ${targetPkg} not found in any ROS_PACKAGE_PATH: ${rosPackagePath}.`,
        );
      }

      const resolvedResourcePath = path.join(pkgRoot, ...relPath.split("/"));
      callback({ path: resolvedResourcePath });
    } catch (err) {
      log.error(err);
      callback({ error: NET_ERROR_FAILED });
    }
  });
}

/** Enable fetch for custom URL schemes. */
export function registerRosPackageProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "package", privileges: { supportFetchAPI: true } },
  ]);
}
