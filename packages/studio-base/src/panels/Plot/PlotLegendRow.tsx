// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useTheme as useFluentUITheme } from "@fluentui/react";
import { Close as CloseIcon, Error as ErrorIcon, Remove as RemoveIcon } from "@mui/icons-material";
import { IconButton, Theme, Tooltip, Typography, useTheme } from "@mui/material";
import { createStyles, makeStyles } from "@mui/styles";
import { ComponentProps, useCallback, useMemo, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import MessagePathInput from "@foxglove/studio-base/components/MessagePathSyntax/MessagePathInput";
import TimeBasedChart from "@foxglove/studio-base/components/TimeBasedChart";
import TimestampMethodDropdown from "@foxglove/studio-base/components/TimestampMethodDropdown";
import { useHoverValue } from "@foxglove/studio-base/context/HoverValueContext";
import { lineColors } from "@foxglove/studio-base/util/plotColors";
import { TimestampMethod } from "@foxglove/studio-base/util/time";

import { PlotPath, isReferenceLinePlotPathType } from "./internalTypes";
import { plotableRosTypes, PlotConfig, PlotXAxisVal } from "./types";

type PlotLegendRowProps = {
  index: number;
  xAxisVal: PlotXAxisVal;
  path: PlotPath;
  paths: PlotPath[];
  hasMismatchedDataLength: boolean;
  datasets: ComponentProps<typeof TimeBasedChart>["data"]["datasets"];
  currentTime?: number;
  saveConfig: (arg0: Partial<PlotConfig>) => void;
  showPlotValuesInLegend: boolean;
};

const useStyles = makeStyles((theme: Theme) =>
  createStyles({
    root: {
      display: "contents",

      "&:hover, &:focus-within": {
        "& .MuiIconButton-root": {
          backgroundColor: theme.palette.action.hover,
        },
        "& > *:last-child": {
          opacity: 1,
        },
        "& > *": {
          backgroundColor: theme.palette.action.hover,
        },
      },
    },
    listIcon: {
      padding: theme.spacing(0.25),
      position: "sticky",
      left: 0,
      // creates an opaque background for the sticky element
      backgroundImage: `linear-gradient(${theme.palette.background.paper}, ${theme.palette.background.paper})`,
      backgroundBlendMode: "overlay",
    },
    legendIconButton: {
      padding: `${theme.spacing(0.125)} !important`,
      marginLeft: theme.spacing(0.25),
    },
    inputWrapper: {
      display: "flex",
      alignItems: "center",
      padding: theme.spacing(0.25),
    },
    plotValue: {
      display: "flex",
      alignItems: "center",
      padding: theme.spacing(0.25),
    },
    removeButton: {
      padding: `${theme.spacing(0.25)} !important`,
      color: theme.palette.text.secondary,

      "&:hover": {
        color: theme.palette.text.primary,
      },
    },
    actions: {
      display: "flex",
      flexDirection: "row",
      alignItems: "center",
      padding: theme.spacing(0.25),
      gap: theme.spacing(0.25),
      position: "sticky",
      right: 0,
      opacity: 0,
      // creates an opaque background for the sticky element
      backgroundImage: `linear-gradient(${theme.palette.background.paper}, ${theme.palette.background.paper})`,
      backgroundBlendMode: "overlay",

      "&:hover": {
        opacity: 1,
      },
    },
  }),
);

export default function PlotLegendRow({
  index,
  xAxisVal,
  path,
  paths,
  hasMismatchedDataLength,
  datasets,
  currentTime,
  saveConfig,
  showPlotValuesInLegend,
}: PlotLegendRowProps): JSX.Element {
  const correspondingData = useMemo(() => {
    if (!showPlotValuesInLegend) {
      return [];
    }
    return datasets.find((set) => set.label === path.value)?.data ?? [];
  }, [datasets, path.value, showPlotValuesInLegend]);

  const [hoverComponentId] = useState<string>(() => uuidv4());
  const hoverValue = useHoverValue({
    componentId: hoverComponentId,
    isTimestampScale: true,
  });

  const fluentUITheme = useFluentUITheme();
  const theme = useTheme();

  const currentDisplay = useMemo(() => {
    if (!showPlotValuesInLegend) {
      return {
        value: undefined,
        color: "inherit",
      };
    }
    const timeToCompare = hoverValue?.value ?? currentTime;

    let value;
    for (const pt of correspondingData) {
      if (timeToCompare == undefined || pt == undefined || pt.x > timeToCompare) {
        break;
      }
      value = pt.y;
    }
    return {
      value,
      color: hoverValue?.value != undefined ? fluentUITheme.palette.yellowDark : "inherit",
    };
  }, [
    showPlotValuesInLegend,
    hoverValue?.value,
    currentTime,
    fluentUITheme.palette.yellowDark,
    correspondingData,
  ]);

  const legendIconColor = path.enabled
    ? lineColors[index % lineColors.length]
    : theme.palette.text.secondary;

  const classes = useStyles();

  const isReferenceLinePlotPath = isReferenceLinePlotPathType(path);
  let timestampMethod;
  // Only allow chosing the timestamp method if it is applicable (not a reference line) and there is at least
  // one character typed.
  if (!isReferenceLinePlotPath && path.value.length > 0) {
    timestampMethod = path.timestampMethod;
  }

  const onInputChange = useCallback(
    (value: string, idx?: number) => {
      if (idx == undefined) {
        throw new Error("index not set");
      }
      const newPaths = paths.slice();
      const newPath = newPaths[idx];
      if (newPath) {
        newPaths[idx] = { ...newPath, value: value.trim() };
      }
      saveConfig({ paths: newPaths });
    },
    [paths, saveConfig],
  );

  const onInputTimestampMethodChange = useCallback(
    (value: TimestampMethod) => {
      const newPaths = paths.slice();
      const newPath = newPaths[index];
      if (newPath) {
        newPaths[index] = { ...newPath, timestampMethod: value };
      }
      saveConfig({ paths: newPaths });
    },
    [paths, index, saveConfig],
  );

  return (
    <div className={classes.root}>
      <div className={classes.listIcon}>
        <IconButton
          className={classes.legendIconButton}
          centerRipple={false}
          size="small"
          title="Toggle visibility"
          onClick={() => {
            const newPaths = paths.slice();
            const newPath = newPaths[index];
            if (newPath) {
              newPaths[index] = { ...newPath, enabled: !newPath.enabled };
            }
            saveConfig({ paths: newPaths });
          }}
        >
          <RemoveIcon style={{ color: legendIconColor }} color="inherit" />
        </IconButton>
      </div>
      <div className={classes.inputWrapper}>
        <MessagePathInput
          supportsMathModifiers
          path={path.value}
          onChange={onInputChange}
          validTypes={plotableRosTypes}
          placeholder="Enter a topic name or a number"
          index={index}
          autoSize
          disableAutocomplete={isReferenceLinePlotPath}
          inputStyle={{ textDecoration: !path.enabled ? "line-through" : undefined }}
          {...(xAxisVal === "timestamp" ? { timestampMethod } : undefined)}
        />
        {hasMismatchedDataLength && (
          <Tooltip
            placement="top"
            title="Mismatch in the number of elements in x-axis and y-axis messages"
          >
            <ErrorIcon fontSize="small" color="error" />
          </Tooltip>
        )}
      </div>
      {showPlotValuesInLegend && (
        <div className={classes.plotValue} style={{ color: currentDisplay.color }}>
          <Typography component="div" variant="body2" align="right" color="inherit">
            {currentDisplay.value ?? ""}
          </Typography>
        </div>
      )}
      <div className={classes.actions}>
        <TimestampMethodDropdown
          path={path.value}
          onTimestampMethodChange={onInputTimestampMethodChange}
          index={index}
          iconButtonProps={{ disabled: !path.value }}
          timestampMethod={xAxisVal === "timestamp" ? timestampMethod : undefined}
        />
        <IconButton
          className={classes.removeButton}
          size="small"
          title={`Remove ${path.value}`}
          onClick={() => {
            const newPaths = paths.slice();
            newPaths.splice(index, 1);
            saveConfig({ paths: newPaths });
          }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </div>
    </div>
  );
}
