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

import { Box, Stack } from "@mui/material";
import { ReactElement } from "react";
import Tree from "react-json-tree";

import { LegacyButton } from "@foxglove/studio-base/components/LegacyStyledComponents";
import { UserNodeLog } from "@foxglove/studio-base/players/UserNodePlayer/types";
import { useJsonTreeTheme } from "@foxglove/studio-base/util/globalConstants";
import { colors } from "@foxglove/studio-base/util/sharedStyleConstants";

type Props = {
  nodeId?: string;
  logs: readonly UserNodeLog[];
  clearLogs: (nodeId: string) => void;
};

const LogsSection = ({ nodeId, logs, clearLogs }: Props): ReactElement => {
  const jsonTreeTheme = useJsonTreeTheme();
  const valueColorMap: Record<string, string> = {
    string: jsonTreeTheme.base0B,
    number: jsonTreeTheme.base09,
    boolean: jsonTreeTheme.base09,
    object: jsonTreeTheme.base08, // null
    undefined: jsonTreeTheme.base08,
  };
  if (logs.length === 0) {
    return (
      <>
        <p>No logs to display.</p>
        <p>
          Invoke <code>log(someValue)</code> in your Foxglove Studio node code to see data printed
          here.
        </p>
      </>
    );
  }
  return (
    <>
      <LegacyButton
        data-test="np-logs-clear"
        style={{ padding: "3px 5px", position: "absolute", right: 5, top: 5 }}
        onClick={() => {
          if (nodeId != undefined) {
            clearLogs(nodeId);
          }
        }}
      >
        clear logs
      </LegacyButton>
      <ul>
        {logs.map(({ source, value }, idx) => {
          const renderTreeObj = value != undefined && typeof value === "object";
          return (
            <Stack
              key={`${idx}${source}`}
              component="li"
              direction="row"
              alignItems="baseline"
              justifyContent="space-between"
              sx={{
                cursor: "default",
                padding: 0.375,
                paddingTop: renderTreeObj ? 0 : 0.75,

                "&:hover": {
                  bgcolor: colors.DARK4,
                },
              }}
            >
              {renderTreeObj ? (
                <Tree hideRoot data={value} invertTheme={false} theme={jsonTreeTheme} />
              ) : (
                <span style={{ color: valueColorMap[typeof value] ?? colors.LIGHT }}>
                  {value == undefined || value === false
                    ? String(value)
                    : (value as React.ReactNode)}
                </span>
              )}
              <Box sx={{ color: colors.DARK9, textDecoration: "underline" }}>{source}</Box>
            </Stack>
          );
        })}
      </ul>
    </>
  );
};

export default LogsSection;
