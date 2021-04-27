// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2019-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { storiesOf } from "@storybook/react";
import { useState } from "react";

import Preferences from "@foxglove-studio/app/components/Preferences";
import AppConfigurationContext, {
  AppConfiguration,
} from "@foxglove-studio/app/context/AppConfigurationContext";

function makeConfiguration(entries?: [string, unknown][]): AppConfiguration {
  const map = new Map<string, unknown>(entries);
  const listeners = new Set<() => void>();
  return {
    get: async (key: string) => map.get(key),
    set: async (key: string, value: unknown) => {
      map.set(key, value);
      [...listeners].forEach((listener) => listener());
    },
    addChangeListener: (_key, cb) => listeners.add(cb),
    removeChangeListener: (_key, cb) => listeners.delete(cb),
  };
}

export function Default(): React.ReactElement {
  const [config] = useState(() => makeConfiguration());
  return (
    <AppConfigurationContext.Provider value={config}>
      <Preferences />
    </AppConfigurationContext.Provider>
  );
}

storiesOf("components/Preferences", module).add("default", () => {
  return Default();
});
