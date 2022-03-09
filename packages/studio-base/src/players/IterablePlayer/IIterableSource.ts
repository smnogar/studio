// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Time } from "@foxglove/rostime";
import { Topic, MessageEvent } from "@foxglove/studio";
import { PlayerProblem } from "@foxglove/studio-base/players/types";

export type Initalization = {
  start: Time;
  end: Time;
  topics: Topic[];
  // Publisher names by topic
  publishersByTopic: Map<string, Set<string>>;

  problems: PlayerProblem[];
};

export type MessageIteratorArgs = {
  topics: string[];
  start?: Time;
  reverse?: boolean;
};

export type IteratorResult =
  | {
      connectionId: number;
      msgEvent: MessageEvent<unknown>;
      problem: undefined;
    }
  | {
      connectionId: number;
      msgEvent: undefined;
      problem: PlayerProblem;
    };

export interface IMessageIterator {
  [Symbol.asyncIterator](): AsyncIterator<Readonly<IteratorResult>>;
}

export interface IIterableSource {
  initialize(): Promise<Initalization>;

  messageIterator(args: MessageIteratorArgs): AsyncIterable<Readonly<IteratorResult>>;
}
