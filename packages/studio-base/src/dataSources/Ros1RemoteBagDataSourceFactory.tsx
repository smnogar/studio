// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { IterablePlayer } from "@foxglove/studio-base/players/IterablePlayer";
import { BagIterableSource } from "@foxglove/studio-base/players/IterablePlayer/BagIterableSource";
import { Player } from "@foxglove/studio-base/players/types";

class Ros1RemoteBagDataSourceFactory implements IDataSourceFactory {
  id = "ros1-remote-bagfile";
  type: IDataSourceFactory["type"] = "remote-file";
  displayName = "ROS 1 Bag";
  iconName: IDataSourceFactory["iconName"] = "FileASPX";
  supportedFileTypes = [".bag"];

  initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const url = args.url;
    if (!url) {
      return;
    }

    const bagSource = new BagIterableSource({ type: "remote", url });
    return new IterablePlayer({
      source: bagSource,
      isSampleDataSource: true,
      name: "Adapted from nuScenes dataset.\nCopyright © 2020 nuScenes.\nhttps://www.nuscenes.org/terms-of-use",
      metricsCollector: args.metricsCollector,
      // Use blank url params so the data source is set in the url
      urlParams: {
        url,
      },
    });
  }
}

export default Ros1RemoteBagDataSourceFactory;
