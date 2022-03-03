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

import { useTheme } from "@fluentui/react";
import CameraControlIcon from "@mdi/svg/svg/camera-control.svg";
import { Stack } from "@mui/material";
import { vec3 } from "gl-matrix";
import { isEqual } from "lodash";
import styled from "styled-components";

import { CameraState, cameraStateSelectors, Vec3 } from "@foxglove/regl-worldview";
import Button from "@foxglove/studio-base/components/Button";
import ExpandingToolbar, { ToolGroup } from "@foxglove/studio-base/components/ExpandingToolbar";
import JsonInput from "@foxglove/studio-base/components/JsonInput";
import { LegacyInput } from "@foxglove/studio-base/components/LegacyStyledComponents";
import { usePanelContext } from "@foxglove/studio-base/components/PanelContext";
import Tooltip from "@foxglove/studio-base/components/Tooltip";
import {
  SValue,
  SLabel,
} from "@foxglove/studio-base/panels/ThreeDimensionalViz/Interactions/styling";
import useSharedStyles from "@foxglove/studio-base/panels/ThreeDimensionalViz/sharedStyles";
import { getNewCameraStateOnFollowChange } from "@foxglove/studio-base/panels/ThreeDimensionalViz/threeDimensionalVizUtils";
import {
  FollowMode,
  ThreeDimensionalVizConfig,
} from "@foxglove/studio-base/panels/ThreeDimensionalViz/types";
import clipboard from "@foxglove/studio-base/util/clipboard";
import { point2DValidator, cameraStateValidator } from "@foxglove/studio-base/util/validators";

export const CAMERA_TAB_TYPE = "Camera";

const LABEL_WIDTH = 112;
const TEMP_VEC3: vec3 = [0, 0, 0];
const ZERO_VEC3 = Object.freeze([0, 0, 0]) as Readonly<vec3>;
const DEFAULT_CAMERA_INFO_WIDTH = 260;

const SRow = styled.div`
  display: flex;
  align-items: center;
`;

type CameraStateInfoProps = {
  cameraState: Partial<CameraState>;
  onAlignXYAxis: () => void;
};

export type CameraInfoPropsWithoutCameraState = {
  followMode: FollowMode;
  followTf?: string;
  isPlaying?: boolean;
  onAlignXYAxis: () => void;
  onCameraStateChange: (arg0: CameraState) => void;
  showCrosshair?: boolean;
  autoSyncCameraState: boolean;
  defaultSelectedTab?: string;
};

export type CameraInfoProps = {
  cameraState: CameraState;
} & CameraInfoPropsWithoutCameraState;

function CameraStateInfo({ cameraState, onAlignXYAxis }: CameraStateInfoProps) {
  const classes = useSharedStyles();
  return (
    <>
      {(Object.keys(cameraState) as (keyof CameraState)[])
        .sort()
        .map((key) => {
          let val: unknown = cameraState[key];
          if (key === "perspective") {
            val = cameraState[key] ?? false ? "true" : "false";
          } else if (Array.isArray(val)) {
            val = val.map((x) => x.toFixed(1)).join(", ");
          } else if (typeof val === "number") {
            val = val.toFixed(2);
          }
          return [key, val as string];
        })
        .map(([key, val]) => (
          <SRow key={key}>
            <SLabel width={LABEL_WIDTH}>{key}:</SLabel> <SValue>{val}</SValue>
            {key === "thetaOffset" && (
              <Button
                className={classes.button}
                onClick={onAlignXYAxis}
                tooltip="Align XY axis by reseting thetaOffset to 0. Will no longer follow orientation."
              >
                RESET
              </Button>
            )}
          </SRow>
        ))}
    </>
  );
}

export default function CameraInfo({
  cameraState,
  followMode,
  followTf,
  isPlaying = false,
  onAlignXYAxis,
  onCameraStateChange,
  showCrosshair = false,
  autoSyncCameraState,
  defaultSelectedTab,
}: CameraInfoProps): JSX.Element {
  const theme = useTheme();
  const classes = useSharedStyles();
  const [selectedTab, setSelectedTab] = React.useState(defaultSelectedTab);
  const { updatePanelConfigs, saveConfig } = usePanelContext();
  const [edit, setEdit] = React.useState<boolean>(false);
  const onEditToggle = React.useCallback(() => setEdit((currVal) => !currVal), []);

  const { target, targetOffset } = cameraState;
  const targetHeading = cameraStateSelectors.targetHeading(cameraState);
  const camPos2D = vec3.add(
    TEMP_VEC3,
    target,
    vec3.rotateZ(TEMP_VEC3, targetOffset, ZERO_VEC3, -targetHeading),
  );
  const camPos2DTrimmed = camPos2D.map((num) => +num.toFixed(2));

  const syncCameraState = () => {
    updatePanelConfigs("3D Panel", (config) => {
      // Transform the camera state by whichever TF or orientation the other panels are following.
      const newCameraState = getNewCameraStateOnFollowChange({
        prevCameraState: cameraState,
        prevFollowTf: followTf,
        prevFollowMode: followMode,
        newFollowTf: (config as ThreeDimensionalVizConfig).followTf,
        newFollowMode: (config as ThreeDimensionalVizConfig).followMode,
      });
      return { ...config, cameraState: newCameraState };
    });
  };

  return (
    <ExpandingToolbar
      tooltip="Camera"
      icon={<CameraControlIcon />}
      checked={autoSyncCameraState}
      selectedTab={selectedTab}
      onSelectTab={(newSelectedTab) => setSelectedTab(newSelectedTab)}
    >
      <ToolGroup name={CAMERA_TAB_TYPE}>
        <>
          <Stack direction="row-reverse" paddingTop={0.5} paddingRight={0.5}>
            <Button
              className={classes.button}
              tooltip="Copy cameraState"
              small
              onClick={() => {
                void clipboard.copy(JSON.stringify(cameraState, undefined, 2) ?? "");
              }}
            >
              Copy
            </Button>
            <Button
              className={classes.button}
              disabled={isPlaying}
              tooltip={
                isPlaying
                  ? "Pause player to edit raw camera state object"
                  : "Edit raw camera state object"
              }
              onClick={onEditToggle}
            >
              {edit ? "Done" : "Edit"}
            </Button>
            <Button
              className={classes.button}
              tooltip="Sync camera state across all 3D panels"
              onClick={syncCameraState}
            >
              Sync
            </Button>
          </Stack>
          <Stack flex="auto" minWidth={DEFAULT_CAMERA_INFO_WIDTH} padding={1}>
            {edit && !isPlaying ? (
              <JsonInput
                value={cameraState}
                onChange={(newCameraState) => saveConfig({ cameraState: newCameraState })}
                dataValidator={cameraStateValidator}
              />
            ) : (
              <Stack flex="auto">
                <CameraStateInfo cameraState={cameraState} onAlignXYAxis={onAlignXYAxis} />
                <Stack flex="auto">
                  <SRow style={{ marginBottom: 8 }}>
                    <Tooltip
                      placement="top"
                      contents="Automatically sync camera across all 3D panels"
                    >
                      <SLabel>Auto sync:</SLabel>
                    </Tooltip>
                    <SValue>
                      <LegacyInput
                        type="checkbox"
                        checked={autoSyncCameraState}
                        onChange={() =>
                          updatePanelConfigs("3D Panel", (config) => ({
                            ...config,
                            cameraState,
                            autoSyncCameraState: !autoSyncCameraState,
                          }))
                        }
                      />
                    </SValue>
                  </SRow>
                  <SRow style={{ marginBottom: 8 }}>
                    <SLabel
                      style={
                        cameraState.perspective ? { color: theme.semanticColors.disabledText } : {}
                      }
                    >
                      Show crosshair:
                    </SLabel>
                    <SValue>
                      <LegacyInput
                        type="checkbox"
                        disabled={cameraState.perspective}
                        checked={showCrosshair}
                        onChange={() => saveConfig({ showCrosshair: !showCrosshair })}
                      />
                    </SValue>
                  </SRow>
                  {showCrosshair && !cameraState.perspective && (
                    <SRow style={{ paddingLeft: LABEL_WIDTH, marginBottom: 8 }}>
                      <SValue>
                        <JsonInput
                          inputStyle={{ width: 140 }}
                          value={{ x: camPos2DTrimmed[0], y: camPos2DTrimmed[1] }}
                          onChange={(data) => {
                            const point = data as { x: number; y: number };
                            const newPos: vec3 = [point.x, point.y, 0];
                            // extract the targetOffset by subtracting from the target and un-rotating by heading
                            const newTargetOffset = vec3.rotateZ(
                              [0, 0, 0],
                              vec3.sub(TEMP_VEC3, newPos, cameraState.target),
                              ZERO_VEC3,
                              cameraStateSelectors.targetHeading(cameraState) as number,
                            ) as Vec3;
                            if (!isEqual(cameraState.targetOffset, newTargetOffset)) {
                              onCameraStateChange({
                                ...cameraState,
                                targetOffset: newTargetOffset,
                              });
                            }
                          }}
                          dataValidator={point2DValidator}
                        />
                      </SValue>
                    </SRow>
                  )}
                </Stack>
                {followMode === "no-follow" && <p>Not following</p>}
                {followMode !== "no-follow" && (
                  <SRow>
                    <SLabel>Following frame:</SLabel>
                    <SValue>
                      <code>{followTf}</code>
                      {followMode === "follow-orientation" && " with orientation"}
                    </SValue>
                  </SRow>
                )}
              </Stack>
            )}
          </Stack>
        </>
      </ToolGroup>
    </ExpandingToolbar>
  );
}
