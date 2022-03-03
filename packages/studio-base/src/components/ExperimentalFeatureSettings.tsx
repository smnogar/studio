// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { Text, useTheme, Checkbox, Link } from "@fluentui/react";
import { Theme } from "@mui/material";
import { makeStyles } from "@mui/styles";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks/useAppConfigurationValue";

type Feature = {
  key: AppSetting;
  name: string;
  description: JSX.Element;
};

const useStyles = makeStyles((theme: Theme) => ({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(2),
  },
  item: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: theme.spacing(0.5),
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(0.5),
    paddingLeft: theme.spacing(0.5),
  },
}));

const features: Feature[] = [
  {
    key: AppSetting.UNLIMITED_MEMORY_CACHE,
    name: "Unlimited in-memory cache",
    description: (
      <>
        Fully buffer a bag into memory. This may use up a lot of system memory. Changing this
        setting requires a restart.
      </>
    ),
  },
  {
    key: AppSetting.SHOW_DEBUG_PANELS,
    name: "Studio debug panels",
    description: <>Show Foxglove Studio debug panels in the &ldquo;Add panel&rdquo; list.</>,
  },
  {
    key: AppSetting.ENABLE_LEGACY_PLOT_PANEL,
    name: "Legacy Plot panel",
    description: <>Enable the Legacy Plot panel.</>,
  },
];
if (process.env.NODE_ENV === "development") {
  features.push({
    key: AppSetting.ENABLE_LAYOUT_DEBUGGING,
    name: "Layout debugging",
    description: <>Show extra controls for developing and debugging layout storage.</>,
  });
  features.push({
    key: AppSetting.ENABLE_REACT_STRICT_MODE,
    name: "React Strict Mode",
    description: (
      <>
        Enable React{" "}
        <Link href="https://reactjs.org/docs/strict-mode.html" target="_blank" rel="noreferrer">
          Strict Mode
        </Link>
        . Changing this setting requires a restart.
      </>
    ),
  });
}

function ExperimentalFeatureItem(props: { feature: Feature }) {
  const classes = useStyles();
  const theme = useTheme();
  const { feature } = props;

  const [enabled, setEnabled] = useAppConfigurationValue<boolean>(feature.key);
  return (
    <div className={classes.item}>
      <Checkbox
        onRenderLabel={() => {
          return (
            <div className={classes.label}>
              <Text variant="medium" styles={{ root: { fontWeight: 600 } }}>
                {feature.name}
              </Text>
              <Text
                variant="smallPlus"
                styles={{ root: { color: theme.semanticColors.bodySubtext } }}
              >
                {feature.description}
              </Text>
            </div>
          );
        }}
        checked={enabled}
        onChange={(_, checked) => void setEnabled(checked)}
        styles={{
          text: {
            minWidth: 60,
          },
          label: { alignItems: "baseline" },
        }}
      />
    </div>
  );
}

export function ExperimentalFeatureSettings(): React.ReactElement {
  const classes = useStyles();

  return (
    <div className={classes.root}>
      {features.length === 0 && (
        <p>
          <em>Currently there are no experimental features.</em>
        </p>
      )}
      {features.map((feature) => (
        <ExperimentalFeatureItem key={feature.key} feature={feature} />
      ))}
    </div>
  );
}
