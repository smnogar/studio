// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { BlockBagPlayer } from "@foxglove/studio-base/players/BlockBagPlayer";
import { Player } from "@foxglove/studio-base/players/types";

class Ros1LocalBagDataSourceFactory implements IDataSourceFactory {
  id = "ros1-local-bagfile";
  type: IDataSourceFactory["type"] = "file";
  displayName = "ROS 1 Bag";
  iconName: IDataSourceFactory["iconName"] = "OpenFile";
  supportedFileTypes = [".bag"];

  initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const file = args.file;
    if (!file) {
      return;
    }

    return new BlockBagPlayer({
      metricsCollector: args.metricsCollector,
      file,
    });
  }
}

export default Ros1LocalBagDataSourceFactory;
