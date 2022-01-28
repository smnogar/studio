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

import { Box } from "@mui/material";
import { useCallback, useState } from "react";

import Tooltip from "@foxglove/studio-base/components/Tooltip";

// Strings longer than this many characters will start off collapsed.
const COLLAPSE_TEXT_OVER_LENGTH = 512;

type Props = { itemLabel: string };

export default function MaybeCollapsedValue({ itemLabel }: Props): JSX.Element {
  const lengthOverLimit = itemLabel.length >= COLLAPSE_TEXT_OVER_LENGTH;

  const [showingEntireLabel, setShowingEntireLabel] = useState(!lengthOverLimit);

  const expandText = useCallback(() => setShowingEntireLabel(true), []);

  const truncatedItemText = showingEntireLabel
    ? itemLabel
    : itemLabel.slice(0, COLLAPSE_TEXT_OVER_LENGTH);

  return (
    <Tooltip contents={!showingEntireLabel ? "Text was truncated, click to see all" : undefined}>
      <Box
        component="span"
        onClick={expandText}
        sx={{ cursor: !showingEntireLabel ? "pointer" : "inherit" }}
      >
        {`${truncatedItemText}${!showingEntireLabel ? "..." : ""}`}
      </Box>
    </Tooltip>
  );
}
