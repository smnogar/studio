// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  PlayerCapabilities,
  PlayerPresence,
  PlayerState,
} from "@foxglove/studio-base/players/types";

import {
  IIterableSource,
  IMessageIterator,
  Initalization,
  MessageIteratorArgs,
  IteratorResult,
} from "./IIterableSource";
import { IterablePlayer } from "./IterablePlayer";

class TestSource implements IIterableSource {
  async initialize(): Promise<Initalization> {
    return {
      start: { sec: 0, nsec: 0 },
      end: { sec: 0, nsec: 0 },
      topics: [],
      problems: [],
      publishersByTopic: new Map(),
    };
  }

  messageIterator(_args: MessageIteratorArgs): IMessageIterator {
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<Readonly<IteratorResult>> {
        /*
        yield {
          connectionId: 0,
          problem: undefined,
          msgEvent: {
            topic: "/topic",
            receiveTime: { sec: 0, nsec: 0 },
            sizeInBytes: 0,
            message: {},
          },
        };
        */
      },
    };
  }
}

type PlayerStateWithoutPlayerId = Omit<PlayerState, "playerId">;

class PlayerStateStore {
  done: Promise<PlayerStateWithoutPlayerId[]>;

  private playerStates: PlayerStateWithoutPlayerId[] = [];
  private expected: number;
  private resolve: (arg0: PlayerStateWithoutPlayerId[]) => void = () => {
    // no-op
  };

  constructor(expected: number) {
    this.expected = expected;
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  async add(state: PlayerState): Promise<void> {
    const { playerId: _playerId, ...rest } = state;
    this.playerStates.push(rest);
    if (this.playerStates.length === this.expected) {
      this.resolve(this.playerStates);
    }
    if (this.playerStates.length > this.expected) {
      const error = new Error(
        `Expected: ${this.expected} messages, received: ${this.playerStates.length}`,
      );
      this.done = Promise.reject(error);
      throw error;
    }
  }

  reset(expected: number): void {
    this.expected = expected;
    this.playerStates = [];
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

function playerStateGenerator(originalState: PlayerStateWithoutPlayerId) {
  return function (modified?: Partial<PlayerState>): PlayerStateWithoutPlayerId {
    if (!modified) {
      return originalState;
    }

    return {
      ...originalState,
      ...modified,
    };
  };
}

describe("IterablePlayer", () => {
  let mockDateNow: jest.SpyInstance<number, []>;
  beforeEach(() => {
    mockDateNow = jest.spyOn(Date, "now").mockReturnValue(0);
  });
  afterEach(async () => {
    mockDateNow.mockRestore();
  });

  it("calls listener with initial player states", async () => {
    const source = new TestSource();
    const player = new IterablePlayer({
      source,
    });
    const store = new PlayerStateStore(5);
    player.setListener(async (state) => await store.add(state));
    const playerStates = await store.done;

    const stateGen = playerStateGenerator({
      activeData: {
        currentTime: { sec: 0, nsec: 0 },
        startTime: { sec: 0, nsec: 0 },
        endTime: { sec: 0, nsec: 0 },
        datatypes: new Map(),
        isPlaying: false,
        lastSeekTime: 0,
        messages: [],
        totalBytesReceived: 0,
        messageOrder: "receiveTime",
        speed: 1.0,
        topics: [],
        parsedMessageDefinitionsByTopic: {},
        publishedTopics: new Map<string, Set<string>>(),
      },
      problems: [],
      capabilities: [PlayerCapabilities.setSpeed, PlayerCapabilities.playbackControl],
      presence: PlayerPresence.INITIALIZING,
      progress: {},
      filePath: undefined,
      urlState: undefined,
      name: undefined,
    });

    expect(playerStates).toEqual([
      // before initialize
      stateGen(),
      // start delay
      stateGen({ presence: PlayerPresence.INITIALIZING }),
      // startPlay
      stateGen({ presence: PlayerPresence.PRESENT }),
      // idle
      stateGen({ presence: PlayerPresence.PRESENT }),
      // load blocks
      stateGen({ presence: PlayerPresence.PRESENT }),
    ]);

    player.close();
  });
});
