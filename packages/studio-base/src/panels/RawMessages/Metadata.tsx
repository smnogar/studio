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
import { Link } from "@fluentui/react";
import styled from "styled-components";

import { MessageEvent } from "@foxglove/studio-base/players/types";
import { formatTimeRaw } from "@foxglove/studio-base/util/time";

import CopyMessageButton from "./CopyMessageButton";
import { getMessageDocumentationLink } from "./utils";

const SMetadata = styled.div`
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.3;
  color: #aaa;
`;
type Props = {
  data: unknown;
  diffData: unknown;
  diff: unknown;
  datatype?: string;
  message: MessageEvent<unknown>;
  diffMessage?: MessageEvent<unknown>;
};

export default function Metadata({
  data,
  diffData,
  diff,
  datatype,
  message,
  diffMessage,
}: Props): JSX.Element {
  return (
    <SMetadata>
      {!diffMessage && datatype && (
        <Link
          style={{ color: "inherit" }}
          rel="noopener noreferrer"
          href={getMessageDocumentationLink(datatype)}
        >
          {datatype}
        </Link>
      )}
      {diffMessage ? " base" : ""} @ {formatTimeRaw(message.receiveTime)} ROS{" "}
      <CopyMessageButton data={data} text="Copy msg" />
      {diffMessage?.receiveTime && (
        <>
          <div>
            {`diff @ ${formatTimeRaw(diffMessage.receiveTime)} ROS `}
            <CopyMessageButton data={diffData} text="Copy msg" />
          </div>
          <CopyMessageButton data={diff} text="Copy diff of msgs" />
        </>
      )}
    </SMetadata>
  );
}
