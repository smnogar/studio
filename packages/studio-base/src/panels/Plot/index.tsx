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
import DownloadOutlineIcon from "@mdi/svg/svg/download-outline.svg";
import { Stack } from "@mui/material";
import { compact, uniq } from "lodash";
import memoizeWeak from "memoize-weak";
import { useEffect, useCallback, useMemo, ComponentProps } from "react";

import { filterMap } from "@foxglove/den/collection";
import {
  Time,
  add as addTimes,
  fromSec,
  subtract as subtractTimes,
  toSec,
} from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import { useBlocksByTopic, useMessageReducer } from "@foxglove/studio-base/PanelAPI";
import { MessageBlock } from "@foxglove/studio-base/PanelAPI/useBlocksByTopic";
import Icon from "@foxglove/studio-base/components/Icon";
import parseRosPath, {
  getTopicsFromPaths,
} from "@foxglove/studio-base/components/MessagePathSyntax/parseRosPath";
import {
  MessageDataItemsByPath,
  useCachedGetMessagePathDataItems,
  useDecodeMessagePathsForMessagesByTopic,
} from "@foxglove/studio-base/components/MessagePathSyntax/useCachedGetMessagePathDataItems";
import {
  MessagePipelineContext,
  useMessagePipeline,
  useMessagePipelineGetter,
} from "@foxglove/studio-base/components/MessagePipeline";
import Panel from "@foxglove/studio-base/components/Panel";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import {
  ChartDefaultView,
  TimeBasedChartTooltipData,
} from "@foxglove/studio-base/components/TimeBasedChart";
import { OnClickArg as OnChartClickArgs } from "@foxglove/studio-base/src/components/Chart";
import {
  OpenSiblingPanel,
  PanelConfig,
  PanelConfigSchema,
} from "@foxglove/studio-base/types/panels";
import { getTimestampForMessage } from "@foxglove/studio-base/util/time";

import PlotChart from "./PlotChart";
import PlotLegend from "./PlotLegend";
import { downloadCSV } from "./csv";
import { getDatasets } from "./datasets";
import helpContent from "./index.help.md";
import { PlotDataByPath, PlotDataItem } from "./internalTypes";
import { PlotConfig } from "./types";

export { plotableRosTypes } from "./types";
export type { PlotConfig, PlotXAxisVal } from "./types";

const defaultSidebarDimension = 240;

export function openSiblingPlotPanel(openSiblingPanel: OpenSiblingPanel, topicName: string): void {
  openSiblingPanel({
    panelType: "Plot",
    updateIfExists: true,
    siblingConfigCreator: (config: PanelConfig) => ({
      ...config,
      paths: uniq(
        (config as PlotConfig).paths
          .concat([{ value: topicName, enabled: true, timestampMethod: "receiveTime" }])
          .filter(({ value }) => value),
      ),
    }),
  });
}

type Props = {
  config: PlotConfig;
  saveConfig: (arg0: Partial<PlotConfig>) => void;
};

// messagePathItems contains the whole parsed message, and we don't need to cache all of that.
// Instead, throw away everything but what we need (the timestamps).
const getPlotDataByPath = (itemsByPath: MessageDataItemsByPath): PlotDataByPath => {
  const ret: PlotDataByPath = {};
  Object.entries(itemsByPath).forEach(([path, items]) => {
    ret[path] = [
      items.map((messageAndData) => {
        const headerStamp = getTimestampForMessage(messageAndData.messageEvent.message);
        return {
          queriedData: messageAndData.queriedData,
          receiveTime: messageAndData.messageEvent.receiveTime,
          headerStamp,
        };
      }),
    ];
  });
  return ret;
};

const getMessagePathItemsForBlock = memoizeWeak(
  (
    decodeMessagePathsForMessagesByTopic: (_: MessageBlock) => MessageDataItemsByPath,
    block: MessageBlock,
  ): PlotDataByPath => {
    return Object.freeze(getPlotDataByPath(decodeMessagePathsForMessagesByTopic(block)));
  },
);

const ZERO_TIME = { sec: 0, nsec: 0 };

function getBlockItemsByPath(
  decodeMessagePathsForMessagesByTopic: (_: MessageBlock) => MessageDataItemsByPath,
  blocks: readonly MessageBlock[],
) {
  const ret: Record<string, PlotDataItem[][]> = {};
  const lastBlockIndexForPath: Record<string, number> = {};
  blocks.forEach((block, i: number) => {
    const messagePathItemsForBlock: PlotDataByPath = getMessagePathItemsForBlock(
      decodeMessagePathsForMessagesByTopic,
      block,
    );
    Object.entries(messagePathItemsForBlock).forEach(([path, messagePathItems]) => {
      const existingItems = ret[path] ?? [];
      // getMessagePathItemsForBlock returns an array of exactly one range of items.
      const [pathItems] = messagePathItems;
      if (lastBlockIndexForPath[path] === i - 1) {
        // If we are continuing directly from the previous block index (i - 1) then add to the
        // existing range, otherwise start a new range
        const currentRange = existingItems[existingItems.length - 1];
        if (currentRange && pathItems) {
          for (const item of pathItems) {
            currentRange.push(item);
          }
        }
      } else {
        if (pathItems) {
          // Start a new contiguous range. Make a copy so we can extend it.
          existingItems.push(pathItems.slice());
        }
      }
      ret[path] = existingItems;
      lastBlockIndexForPath[path] = i;
    });
  });
  return ret;
}

function selectStartTime(ctx: MessagePipelineContext) {
  return ctx.playerState.activeData?.startTime;
}

function selectCurrentTime(ctx: MessagePipelineContext) {
  return ctx.playerState.activeData?.currentTime;
}

function selectEndTime(ctx: MessagePipelineContext) {
  return ctx.playerState.activeData?.endTime;
}

function Plot(props: Props) {
  const { saveConfig, config } = props;
  const {
    title,
    followingViewWidth,
    paths: yAxisPaths,
    minYValue,
    maxYValue,
    showXAxisLabels,
    showYAxisLabels,
    showLegend,
    legendDisplay = config.showSidebar === true ? "left" : "floating",
    showPlotValuesInLegend,
    isSynced,
    xAxisVal,
    xAxisPath,
    sidebarDimension = config.sidebarWidth ?? defaultSidebarDimension,
  } = config;
  const theme = useTheme();

  useEffect(() => {
    if (yAxisPaths.length === 0) {
      saveConfig({ paths: [{ value: "", enabled: true, timestampMethod: "receiveTime" }] });
    }
  }, [saveConfig, yAxisPaths.length]);

  const showSingleCurrentMessage = xAxisVal === "currentCustom" || xAxisVal === "index";

  const startTime = useMessagePipeline(selectStartTime);
  const currentTime = useMessagePipeline(selectCurrentTime);
  const endTime = useMessagePipeline(selectEndTime);

  // Min/max x-values and playback position indicator are only used for preloaded plots. In non-
  // preloaded plots min x-value is always the last seek time, and the max x-value is the current
  // playback time.
  const timeSincePreloadedStart = (time?: Time): number | undefined => {
    if (xAxisVal === "timestamp" && time && startTime) {
      return toSec(subtractTimes(time, startTime));
    }
    return undefined;
  };

  const currentTimeSinceStart = timeSincePreloadedStart(currentTime);

  const followingView = useMemo<ChartDefaultView | undefined>(() => {
    if (followingViewWidth != undefined && +followingViewWidth > 0) {
      return { type: "following", width: +followingViewWidth };
    }
    return undefined;
  }, [followingViewWidth]);

  const endTimeSinceStart = timeSincePreloadedStart(endTime);
  const fixedView = useMemo<ChartDefaultView | undefined>(() => {
    if (xAxisVal === "timestamp" && startTime && endTimeSinceStart != undefined) {
      return { type: "fixed", minXValue: 0, maxXValue: endTimeSinceStart };
    }
    return undefined;
  }, [endTimeSinceStart, startTime, xAxisVal]);

  // following view and fixed view are split to keep defaultView identity stable when possible
  const defaultView = useMemo<ChartDefaultView | undefined>(() => {
    if (followingView) {
      return followingView;
    } else if (fixedView) {
      return fixedView;
    }
    return undefined;
  }, [fixedView, followingView]);

  const allPaths = useMemo(() => {
    return yAxisPaths.map(({ value }) => value).concat(compact([xAxisPath?.value]));
  }, [xAxisPath?.value, yAxisPaths]);

  const subscribeTopics = useMemo(() => getTopicsFromPaths(allPaths), [allPaths]);

  const cachedGetMessagePathDataItems = useCachedGetMessagePathDataItems(allPaths);
  const decodeMessagePathsForMessagesByTopic = useDecodeMessagePathsForMessagesByTopic(allPaths);

  // When iterating message events, we need a reverse lookup from topic to the paths that requested
  // the topic.
  const topicToPaths = useMemo<Map<string, string[]>>(() => {
    const out = new Map<string, string[]>();
    for (const path of allPaths) {
      const rosPath = parseRosPath(path);
      if (!rosPath) {
        continue;
      }
      const existing = out.get(rosPath.topicName) ?? [];
      existing.push(path);
      out.set(rosPath.topicName, existing);
    }
    return out;
  }, [allPaths]);

  const blocks = useBlocksByTopic(subscribeTopics);

  // This memoization isn't quite ideal: getDatasets is a bit expensive with lots of preloaded data,
  // and when we preload a new block we re-generate the datasets for the whole timeline. We could
  // try to use block memoization here.
  const plotDataForBlocks = useMemo(() => {
    if (showSingleCurrentMessage) {
      return {};
    }
    return getBlockItemsByPath(decodeMessagePathsForMessagesByTopic, blocks);
  }, [blocks, decodeMessagePathsForMessagesByTopic, showSingleCurrentMessage]);

  // When restoring, keep only the paths that are present in allPaths.
  // Without this, the reducer value will grow unbounded with new paths as users add/remove series.
  const restore = useCallback(
    (previous?: PlotDataByPath): PlotDataByPath => {
      if (!previous) {
        return {};
      }

      const updated: PlotDataByPath = {};
      for (const path of allPaths) {
        const plotData = previous[path];
        if (plotData) {
          updated[path] = plotData;
        }
      }

      return updated;
    },
    [allPaths],
  );

  const addMessages = useCallback(
    (accumulated: PlotDataByPath, msgEvents: readonly MessageEvent<unknown>[]) => {
      const lastEventTime = msgEvents[msgEvents.length - 1]?.receiveTime;
      const isFollowing = followingView?.type === "following";

      // If we don't change any accumulated data, avoid returning a new "accumulated" object so
      // react hooks remain stable.
      let changed = false;

      for (const msgEvent of msgEvents) {
        const paths = topicToPaths.get(msgEvent.topic);
        if (!paths) {
          continue;
        }

        for (const path of paths) {
          // Skip any paths we already service in plotDataForBlocks.
          // We don't need to accumulate these because the block data takes precedence.
          if (path in plotDataForBlocks) {
            continue;
          }

          const dataItem = cachedGetMessagePathDataItems(path, msgEvent);
          if (!dataItem) {
            continue;
          }

          const headerStamp = getTimestampForMessage(msgEvent.message);
          const plotDataItem = {
            queriedData: dataItem,
            receiveTime: msgEvent.receiveTime,
            headerStamp,
          };

          changed = true;

          if (showSingleCurrentMessage) {
            accumulated[path] = [[plotDataItem]];
          } else {
            const plotDataPath = (accumulated[path] ??= [[]]);
            // PlotDataPaths have 2d arrays of items to accomodate blocks which may have gaps so
            // each continuous set of blocks forms one continuous line. For streaming messages we
            // treat this as one continuous set of items and always add to the first "range"
            const plotDataItems = plotDataPath[0]!;
            plotDataItems.push(plotDataItem);

            // If we are using the _following_ view mode, truncate away any items older than the view window.
            if (lastEventTime && isFollowing) {
              const minStamp = toSec(lastEventTime) - followingView.width;
              plotDataPath[0] = filterMap(plotDataItems, (item) => {
                if (toSec(item.receiveTime) < minStamp) {
                  return undefined;
                }
                return item;
              });
            }
          }
        }
      }

      if (!changed) {
        return accumulated;
      }

      return { ...accumulated };
    },
    [
      plotDataForBlocks,
      cachedGetMessagePathDataItems,
      followingView,
      showSingleCurrentMessage,
      topicToPaths,
    ],
  );

  const plotDataByPath = useMessageReducer<PlotDataByPath>({
    topics: subscribeTopics,
    preloadType: "full",
    restore,
    addMessages,
  });

  // Keep disabled paths when passing into getDatasets, because we still want
  // easy access to the history when turning the disabled paths back on.
  const { datasets, pathsWithMismatchedDataLengths } = useMemo(() => {
    const allPlotData = { ...plotDataByPath, ...plotDataForBlocks };

    return getDatasets({
      paths: yAxisPaths,
      itemsByPath: allPlotData,
      startTime: startTime ?? ZERO_TIME,
      xAxisVal,
      xAxisPath,
      invertedTheme: theme.isInverted,
    });
  }, [
    plotDataByPath,
    plotDataForBlocks,
    yAxisPaths,
    startTime,
    xAxisVal,
    xAxisPath,
    theme.isInverted,
  ]);

  const tooltips = useMemo(() => {
    if (showLegend && showPlotValuesInLegend) {
      return [];
    }
    const allTooltips: TimeBasedChartTooltipData[] = [];
    for (const dataset of datasets) {
      for (const datum of dataset.data) {
        allTooltips.push(datum);
      }
    }
    return allTooltips;
  }, [datasets, showLegend, showPlotValuesInLegend]);

  const messagePipeline = useMessagePipelineGetter();
  const onClick = useCallback<NonNullable<ComponentProps<typeof PlotChart>["onClick"]>>(
    ({ x: seekSeconds }: OnChartClickArgs) => {
      const {
        seekPlayback,
        playerState: { activeData: { startTime: start } = {} },
      } = messagePipeline();
      if (!seekPlayback || !start || seekSeconds == undefined || xAxisVal !== "timestamp") {
        return;
      }
      // Avoid normalizing a negative time if the clicked point had x < 0.
      if (seekSeconds >= 0) {
        seekPlayback(addTimes(start, fromSec(seekSeconds)));
      }
    },
    [messagePipeline, xAxisVal],
  );

  const stackDirection = useMemo(
    () => (legendDisplay === "top" ? "column" : "row"),
    [legendDisplay],
  );

  return (
    <Stack
      flex="auto"
      alignItems="center"
      justifyContent="center"
      overflow="hidden"
      position="relative"
    >
      <PanelToolbar
        helpContent={helpContent}
        additionalIcons={
          <Icon
            fade
            onClick={() => downloadCSV(datasets, xAxisVal)}
            tooltip="Download plot data as CSV"
          >
            <DownloadOutlineIcon />
          </Icon>
        }
        floating
      />
      <Stack direction={stackDirection} flex="auto" width="100%" height="100%">
        <PlotLegend
          paths={yAxisPaths}
          datasets={datasets}
          currentTime={currentTimeSinceStart}
          saveConfig={saveConfig}
          showLegend={showLegend}
          xAxisVal={xAxisVal}
          xAxisPath={xAxisPath}
          pathsWithMismatchedDataLengths={pathsWithMismatchedDataLengths}
          legendDisplay={legendDisplay}
          showPlotValuesInLegend={showPlotValuesInLegend}
          sidebarDimension={sidebarDimension}
        />
        <Stack flex="auto" alignItems="center" justifyContent="center" overflow="hidden">
          {title && <div>{title}</div>}
          <PlotChart
            isSynced={xAxisVal === "timestamp" && isSynced}
            paths={yAxisPaths}
            minYValue={parseFloat((minYValue ?? "").toString())}
            maxYValue={parseFloat((maxYValue ?? "").toString())}
            showXAxisLabels={showXAxisLabels}
            showYAxisLabels={showYAxisLabels}
            datasets={datasets}
            tooltips={tooltips}
            xAxisVal={xAxisVal}
            currentTime={currentTimeSinceStart}
            onClick={onClick}
            defaultView={defaultView}
          />
        </Stack>
      </Stack>
    </Stack>
  );
}

const configSchema: PanelConfigSchema<PlotConfig> = [
  { key: "title", type: "text", title: "Title", placeholder: "Untitled" },
  {
    key: "isSynced",
    type: "toggle",
    title: "Sync with other timestamp-based plots",
  },
  {
    key: "legendDisplay",
    type: "dropdown",
    title: "Legend display",
    options: [
      { value: "floating", text: "floating" },
      { value: "left", text: "left" },
      { value: "top", text: "top" },
    ],
  },
  {
    key: "showPlotValuesInLegend",
    type: "toggle",
    title: "Show plot values in legend",
  },
  {
    key: "showXAxisLabels",
    type: "toggle",
    title: "Show x-axis label",
  },
  {
    key: "showYAxisLabels",
    type: "toggle",
    title: "Show y-axis label",
  },
  { key: "maxYValue", type: "number", title: "Y max", placeholder: "auto", allowEmpty: true },
  { key: "minYValue", type: "number", title: "Y min", placeholder: "auto", allowEmpty: true },
  {
    key: "followingViewWidth",
    type: "number",
    title: "X range in seconds (for timestamp plots only)",
    placeholder: "auto",
    allowEmpty: true,
    validate: (x) => (x > 0 ? x : undefined),
  },
];

const defaultConfig: PlotConfig = {
  title: undefined,
  paths: [{ value: "", enabled: true, timestampMethod: "receiveTime" }],
  minYValue: "",
  maxYValue: "",
  showXAxisLabels: true,
  showYAxisLabels: true,
  showLegend: true,
  legendDisplay: "floating",
  showPlotValuesInLegend: false,
  isSynced: true,
  xAxisVal: "timestamp",
  sidebarDimension: defaultSidebarDimension,
};

export default Panel(
  Object.assign(Plot, {
    panelType: "Plot",
    defaultConfig,
    configSchema,
  }),
);
