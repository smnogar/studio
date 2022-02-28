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

import { v4 as uuidv4 } from "uuid";
import decompressLZ4 from "wasm-lz4";

import Log from "@foxglove/log";
import { Bag, MessageData } from "@foxglove/rosbag";
import { BlobReader } from "@foxglove/rosbag/web";
import { parse as parseMessageDefinition } from "@foxglove/rosmsg";
import { LazyMessageReader } from "@foxglove/rosmsg-serialization";
import {
  Time,
  add,
  compare,
  clampTime,
  fromMillis,
  fromNanoSec,
  toNanoSec,
  subtract as subtractTimes,
} from "@foxglove/rostime";
import { MessageEvent } from "@foxglove/studio";
import { ParameterValue } from "@foxglove/studio";
import NoopMetricsCollector from "@foxglove/studio-base/players/NoopMetricsCollector";
import {
  AdvertiseOptions,
  Player,
  PlayerMetricsCollectorInterface,
  PlayerState,
  Progress,
  PublishPayload,
  SubscribePayload,
  Topic,
  ParsedMessageDefinitionsByTopic,
  PlayerPresence,
  PlayerProblem,
  PlayerCapabilities,
} from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import { getBagChunksOverlapCount } from "@foxglove/studio-base/util/bags";
import delay from "@foxglove/studio-base/util/delay";
import { SEEK_ON_START_NS, TimestampMethod } from "@foxglove/studio-base/util/time";
import Bzip2 from "@foxglove/wasm-bz2";

const log = Log.getLogger(__filename);

// Amount to wait until panels have had the chance to subscribe to topics before
// we start playback
const SEEK_START_DELAY_MS = 100;

// Messages are laid out in blocks with a fixed number of milliseconds.
const MIN_MEM_CACHE_BLOCK_SIZE_NS = 0.1e9;

// fixme - why not have each block be a fixed size rather than max blocks
// Preloading algorithms get too slow when there are too many blocks. For very long bags, use longer
// blocks. Adaptive block sizing is simpler than using a tree structure for immutable updates but
// less flexible, so we may want to move away from a single-level block structure in the future.
const MAX_BLOCKS = 400;

export type BlockBagPlayerOptions = {
  metricsCollector?: PlayerMetricsCollectorInterface;

  // Optional player name
  file: File;

  // Optional set of key/values to store with url handling
  urlParams?: Record<string, string>;

  isSampleDataSource?: boolean;
};

type MessageBlock = {
  readonly messagesByTopic: {
    readonly [topic: string]: MessageEvent<unknown>[];
  };
  readonly sizeInBytes: number;
};

type BagPlayerState =
  | "preinit"
  | "initialize"
  | "start-delay"
  | "start-play"
  | "idle"
  | "seek-backfill"
  | "play";

// A `Player` that wraps around a tree of `RandomAccessDataProviders`.
export default class BlockBagPlayer implements Player {
  private _urlParams?: Record<string, string>;
  private _name?: string;
  private _filePath?: string;
  private _nextState?: BagPlayerState;
  private _state: BagPlayerState = "preinit";
  private _runningState: boolean = false;

  private _isPlaying: boolean = false;
  private _listener?: (playerState: PlayerState) => Promise<void>;
  private _speed: number = 0.2;
  private _start: Time = { sec: 0, nsec: 0 };
  private _end: Time = { sec: 0, nsec: 0 };

  // next read start time indicates where to start reading for the next tick
  // after a tick read, it is set to 1nsec past the end of the read operation (preparing for the next tick)
  private _lastTickMillis?: number;
  // This is the "lastSeekTime" emitted in the playerState. It is not the same as the _lastSeekStartTime because we can
  // start a seek and not end up emitting it, or emit something else while we are requesting messages for the seek. The
  // RandomAccessDataProvider's `progressCallback` can cause an emit at any time, for example.
  // We only want to set the "lastSeekTime" exactly when we emit the messages coming from the seek.
  private _lastSeekEmitTime: number = Date.now();

  private _providerTopics: Topic[] = [];
  private _providerDatatypes: RosDatatypes = new Map();

  private _capabilities: string[] = [
    PlayerCapabilities.setSpeed,
    PlayerCapabilities.playbackControl,
  ];
  private _metricsCollector: PlayerMetricsCollectorInterface;
  private _subscriptions: SubscribePayload[] = [];

  private _progress: Progress = Object.freeze({});
  private _id: string = uuidv4();
  private _messages: MessageEvent<unknown>[] = [];
  private _receivedBytes: number = 0;
  private _messageOrder: TimestampMethod = "receiveTime";
  private _hasError = false;
  private _lastRangeMillis?: number;
  private _parsedMessageDefinitionsByTopic: ParsedMessageDefinitionsByTopic = {};
  private _bag: Bag | undefined;
  private _file: File;
  private _closed: boolean = false;
  private _readersByConnectionId = new Map<number, LazyMessageReader>();
  private _topicsByConnectionId = new Map<number, string>();
  private _forwardIterator?: ReturnType<Bag["forwardIterator"]>;
  private _lastMessage?: MessageEvent<unknown>;
  private _publishedTopics = new Map<string, Set<string>>();
  private _seekTarget?: Time;

  // To keep reference equality for downstream user memoization cache the currentTime provided in the last activeData update
  // See additional comments below where _currentTime is set
  private _currentTime?: Time;

  // The problem store holds problems based on keys (which may be hard-coded problem types or topics)
  // The overall player may be healthy, but individual topics may have warnings or errors.
  // These are set/cleared in the store to track the current set of problems
  private _problems = new Map<string, PlayerProblem>();

  private _blocks: (MessageBlock | undefined)[] = [];
  private _blockDurationNanos: number = 0;

  // fixme - change to map of id -> array of functions
  private _blockRequests: { blockId: number; resolve: (block: MessageBlock) => void }[] = [];

  constructor(options: BlockBagPlayerOptions) {
    const { metricsCollector, urlParams, file } = options;

    this._name = file.name;
    this._file = file;
    this._urlParams = urlParams;
    this._metricsCollector = metricsCollector ?? new NoopMetricsCollector();
    this._metricsCollector.playerConstructed();
  }

  private _setError(message: string, error?: Error): void {
    this._hasError = true;
    this._problems.set("global-error", {
      severity: "error",
      message,
      error,
    });
    this._isPlaying = false;
  }

  setListener(listener: (playerState: PlayerState) => Promise<void>): void {
    if (this._listener) {
      throw new Error("Cannot setListener again");
    }
    this._listener = listener;
    this._setState("initialize");
  }

  private async _stateInitialize(): Promise<void> {
    // emit state indicating start of initialization
    await this._emitState();

    await decompressLZ4.isLoaded;
    const bzip2 = await Bzip2.init();

    try {
      this._bag = new Bag(new BlobReader(this._file), {
        noParse: true,
        decompress: {
          bz2: (buffer: Uint8Array, size: number) => {
            return bzip2.decompress(buffer, size, { small: false });
          },
          lz4: (buffer: Uint8Array, size: number) => {
            return decompressLZ4(buffer, size);
          },
        },
      });
      await this._bag.open();

      const chunksOverlapCount = getBagChunksOverlapCount(this._bag.chunkInfos);
      // If >25% of the chunks overlap, show a warning. It's common for a small number of chunks to overlap
      // since it looks like `rosbag record` has a bit of a race condition, and that's not too terrible, so
      // only warn when there's a more serious slowdown.
      if (chunksOverlapCount > this._bag.chunkInfos.length * 0.25) {
        const message = `This bag has many overlapping chunks (${chunksOverlapCount} out of ${this._bag.chunkInfos.length}). This results in more memory use during playback.`;
        const tip = "Re-sort the messages in your bag by receive time.";
        this._problems.set("unsorted", {
          severity: "warn",
          message,
          tip,
        });
      }

      this._start = this._currentTime = this._bag.startTime ?? { sec: 0, nsec: 0 };
      this._end = this._bag.endTime ?? { sec: 0, nsec: 0 };

      this._providerTopics = [];
      for (const [id, connection] of this._bag.connections) {
        const datatype = connection.type;
        if (!datatype) {
          continue;
        }

        let publishers = this._publishedTopics.get(connection.topic);
        if (publishers == undefined) {
          publishers = new Set<string>();
          this._publishedTopics.set(connection.topic, publishers);
        }
        if (connection.callerid) {
          publishers.add(connection.callerid);
        }

        this._providerTopics.push({
          name: connection.topic,
          datatype,
        });
        const parsedDefinition = parseMessageDefinition(connection.messageDefinition);
        this._parsedMessageDefinitionsByTopic[connection.topic] = parsedDefinition;

        const reader = new LazyMessageReader(parsedDefinition);
        this._readersByConnectionId.set(id, reader);
        this._topicsByConnectionId.set(id, connection.topic);
      }

      const totalNs = Number(toNanoSec(subtractTimes(this._end, this._start))) + 1; // +1 since times are inclusive.
      if (totalNs > Number.MAX_SAFE_INTEGER * 0.9) {
        throw new Error("Time range is too long to be supported");
      }

      this._blockDurationNanos = Math.ceil(
        Math.max(MIN_MEM_CACHE_BLOCK_SIZE_NS, totalNs / MAX_BLOCKS),
      );
      const blockCount = Math.ceil(totalNs / this._blockDurationNanos);
      this._blocks = Array.from({ length: blockCount });
    } catch (error) {
      this._setError(`Error initializing bag: ${error.message}`, error);
    }

    await this._emitState();
    this._setState("start-delay");
  }

  private async _stateStartDelay() {
    // Wait a bit until panels have had the chance to subscribe to topics before we start
    // playback.
    await new Promise((resolve) => setTimeout(resolve, SEEK_START_DELAY_MS));
    if (this._closed || this._nextState) {
      return;
    }

    this._setState("start-play");
  }

  private async _stateStartPlay() {
    if (!this._bag) {
      return;
    }

    void this.startBlockLoad(this._start);

    // how do we wait for the block to be loaded?

    // forward iterator can do this behind the scenes for us?

    const block = await new Promise<MessageBlock>((resolve) => {
      const timeNanos = 0;
      const blockIndex = Math.floor(timeNanos / this._blockDurationNanos);

      const existingBlock = this._blocks[blockIndex];
      if (!existingBlock) {
        // wait for the block to be available
        this._blockRequests.push({
          blockId: blockIndex,
          resolve,
        });
        return;
      }

      // fixme - also wait for block to have the topics we need
      resolve(existingBlock);
    });

    // forward iterator is invalidated when the block changes
    const topics = new Set(this._subscriptions.map((subscription) => subscription.topic));

    const stopTime = clampTime(
      add(this._start, fromNanoSec(SEEK_ON_START_NS)),
      this._start,
      this._end,
    );

    const events: MessageEvent<unknown>[] = [];
    for (const topic of topics) {
      const topicEvents = block.messagesByTopic[topic];
      if (!topicEvents) {
        throw new Error(`missing topic ${topic} in block`);
      }

      for (const event of topicEvents) {
        if (compare(event.receiveTime, stopTime) > 0) {
          continue;
        }
        events.push(event);
      }
    }

    events.sort((a, b) => compare(a.receiveTime, b.receiveTime));

    /*
    this._forwardIterator = this._bag.forwardIterator({
      topics: Array.from(topics),
    });

    this._lastMessage = undefined;

    const messageEvents: MessageEvent<unknown>[] = [];
    for await (const msg of this._forwardIterator) {
      // Something requested a new state while we were loading
      if (this._nextState) {
        log.info("Exit startPlay for new state");
        return;
      }

      if (!msg) {
        continue;
      }

      const event = this._messageDataToMessageEvent(msg);
      if (!event) {
        // fixme - problem?
        continue;
      }
      if (compare(event.receiveTime, stopTime) > 0) {
        this._lastMessage = event;
        break;
      }

      messageEvents.push(event);
    }
    */

    this._currentTime = stopTime;
    this._messages = events;
    await this._emitState();
    this._setState("idle");
  }

  private async _stateSeekBackfill() {
    if (!this._bag) {
      this._setState("initialize");
      return;
    }

    const targetTime = this._seekTarget;
    if (!targetTime) {
      return;
    }

    const topics = new Set(this._subscriptions.map((subscription) => subscription.topic));

    const messages: MessageEvent<unknown>[] = [];
    for (const topic of topics) {
      const topicIterator = this._bag.reverseIterator({ topics: [topic], position: targetTime });
      for await (const message of topicIterator) {
        // A new state request during backfill, cancel the backfill to service the new state
        if (this._nextState) {
          return;
        }

        if (message) {
          const event = this._messageDataToMessageEvent(message);
          if (event) {
            messages.push(event);
          }
        }
        break;
      }
    }

    // Sort messages in increasing receiveTime order
    messages.sort((a, b) => compare(a.receiveTime, b.receiveTime));

    this._messages = messages;
    this._currentTime = targetTime;

    // Our reverse iterators loaded the messages _at_ our seek time, so playback starts
    // at the next time.
    const forwardPosition = add(targetTime, { sec: 0, nsec: 1 });

    this._forwardIterator = this._bag.forwardIterator({
      topics: Array.from(topics),
      position: forwardPosition,
    });

    this._lastMessage = undefined;
    this._seekTarget = undefined;
    this._lastSeekEmitTime = Date.now();
    await this._emitState();

    if (this._isPlaying) {
      this._setState("play");
    } else {
      this._setState("idle");
    }
  }

  private _setState(newState: BagPlayerState) {
    log.debug(`Next state: ${newState}`);
    this._nextState = newState;
    void this._runState();
  }

  private async _runState() {
    if (this._runningState) {
      return;
    }

    this._runningState = true;
    try {
      while (this._nextState) {
        const state = (this._state = this._nextState);
        this._nextState = undefined;

        log.debug(`Start state: ${state}`);

        switch (state) {
          case "preinit":
            await this._emitState();
            break;
          case "initialize":
            await this._stateInitialize();
            break;
          case "start-delay":
            await this._stateStartDelay();
            break;
          case "start-play":
            await this._stateStartPlay();
            break;
          case "idle":
            await this._emitState();
            break;
          case "seek-backfill":
            await this._stateSeekBackfill();
            break;
          case "play":
            await this._statePlay();
            break;
        }

        log.debug(`Done state ${state}`);
      }
    } finally {
      this._runningState = false;
    }
  }

  private async _emitState() {
    if (!this._listener) {
      return undefined;
    }

    if (this._hasError) {
      return await this._listener({
        name: this._name,
        filePath: this._filePath,
        presence: PlayerPresence.ERROR,
        progress: {},
        capabilities: this._capabilities,
        playerId: this._id,
        activeData: undefined,
        problems: Array.from(this._problems.values()),
      });
    }

    const messages = this._messages;
    this._messages = [];

    const currentTime = this._currentTime ?? this._start;
    const isInitalizing =
      this._state === "preinit" || this._state === "initialize" || this._state === "start-delay";

    const data: PlayerState = {
      name: this._name,
      filePath: this._filePath,
      presence: isInitalizing ? PlayerPresence.INITIALIZING : PlayerPresence.PRESENT,
      progress: this._progress,
      capabilities: this._capabilities,
      playerId: this._id,
      problems: this._problems.size > 0 ? Array.from(this._problems.values()) : undefined,
      activeData: {
        messages,
        totalBytesReceived: this._receivedBytes,
        messageOrder: this._messageOrder,
        currentTime,
        startTime: this._start,
        endTime: this._end,
        isPlaying: this._isPlaying,
        speed: this._speed,
        lastSeekTime: this._lastSeekEmitTime,
        topics: this._providerTopics,
        datatypes: this._providerDatatypes,
        publishedTopics: this._publishedTopics,
        parsedMessageDefinitionsByTopic: this._parsedMessageDefinitionsByTopic,
      },
      urlState: this._urlParams,
    };

    return await this._listener(data);
  }

  private _messageDataToMessageEvent(message: MessageData): MessageEvent<unknown> | undefined {
    const reader = this._readersByConnectionId.get(message.conn);
    if (!reader) {
      return undefined;
    }

    const topic = this._topicsByConnectionId.get(message.conn);
    if (!topic) {
      return undefined;
    }

    if (!message.data) {
      return undefined;
    }

    const parsedMessage = reader.readMessage(message.data);

    const event: MessageEvent<unknown> = {
      topic,
      receiveTime: message.time,
      message: parsedMessage,
      sizeInBytes: message.data.length,
    };

    return event;
  }

  private async _tick(): Promise<void> {
    if (!this._isPlaying) {
      return;
    }

    if (!this._forwardIterator) {
      return;
    }

    // compute how long of a time range we want to read by taking into account
    // the time since our last read and how fast we're currently playing back
    const tickTime = performance.now();
    const durationMillis =
      this._lastTickMillis != undefined && this._lastTickMillis !== 0
        ? tickTime - this._lastTickMillis
        : 20;
    this._lastTickMillis = tickTime;

    // Read at most 300ms worth of messages, otherwise things can get out of control if rendering
    // is very slow. Also, smooth over the range that we request, so that a single slow frame won't
    // cause the next frame to also be unnecessarily slow by increasing the frame size.
    let rangeMillis = Math.min(durationMillis * this._speed, 300);
    if (this._lastRangeMillis != undefined) {
      rangeMillis = this._lastRangeMillis * 0.9 + rangeMillis * 0.1;
    }
    this._lastRangeMillis = rangeMillis;

    if (!this._currentTime) {
      // fixme - problem?
      return;
    }

    // The end time is our current time plus the range we want to read
    const end: Time = clampTime(
      add(this._currentTime, fromMillis(rangeMillis)),
      this._start,
      this._end,
    );

    const messages: MessageEvent<unknown>[] = [];
    if (this._lastMessage) {
      messages.push(this._lastMessage);
      this._lastMessage = undefined;
    }

    // fixme - when we pause, should the last set of messages be emitted?

    for await (const message of this._forwardIterator) {
      if (!message) {
        // end of stream
        console.log("end of stream...?");
        break;
      }

      const event = this._messageDataToMessageEvent(message);
      if (!event) {
        break;
      }

      // State change request during playback
      // eslint disable because typescript doesn't realize isPlaying could change under us
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (this._nextState || !this._isPlaying) {
        this._lastMessage = event;
        break;
      }

      // The message is past the end time, we need to save it for next tick
      if (compare(event.receiveTime, end) > 0) {
        this._lastMessage = event;
        break;
      }

      messages.push(event);
    }

    // fixme - if seeking, then don't emit state, seeking will handle

    // if we paused while reading then do not emit messages?
    // we've already consumed the messages tho! so we need to keep them around

    this._currentTime = end;
    this._messages = messages;
    await this._emitState();
  }

  private async _statePlay() {
    const subscriptions = this._subscriptions;

    try {
      while (this._isPlaying && !this._hasError && !this._nextState) {
        const start = Date.now();
        await this._tick();

        // If subscriptions changed, update to the new subscriptions
        if (this._subscriptions !== subscriptions) {
          // Discard any last message event since the new iterator will repeat it
          this._lastMessage = undefined;

          const topics = new Set(this._subscriptions.map((sub) => sub.topic));
          this._forwardIterator = this._bag?.forwardIterator({
            topics: Array.from(topics),
            position: this._currentTime,
          });
        }

        const time = Date.now() - start;
        // make sure we've slept at least 16 millis or so (aprox 1 frame)
        // to give the UI some time to breathe and not burn in a tight loop
        if (time < 16) {
          await delay(16 - time);
        }
      }
    } catch (err) {
      this._setError((err as Error).message, err);
      await this._emitState();
    }
  }

  private async startBlockLoad(time: Time) {
    if (!this._bag) {
      return;
    }

    console.log("start block load");

    const topics = new Set(this._subscriptions.map((subscription) => subscription.topic));

    console.log({ topics });
    const timeNanos = Number(toNanoSec(subtractTimes(time, this._start)));

    const blockIndex = Math.floor(timeNanos / this._blockDurationNanos);
    console.log({ blockIndex });

    for (let idx = blockIndex; blockIndex < this._blocks.length; ++idx) {
      const existingBlock = this._blocks[idx];
      const blockTopics = existingBlock ? Object.keys(existingBlock.messagesByTopic) : [];

      const topicsToFetch = new Set(topics);
      for (const topic of blockTopics) {
        topicsToFetch.delete(topic);
      }

      console.log({ topicsToFetch });

      // This block has all the topics
      if (topicsToFetch.size === 0) {
        continue;
      }

      const blockStartTime = add(
        this._start,
        fromNanoSec(BigInt(blockIndex * this._blockDurationNanos)),
      );

      const iterator = this._bag.forwardIterator({
        topics: Array.from(topics),
        position: blockStartTime,
      });

      const messagesByTopic: Record<string, MessageEvent<unknown>[]> = {};
      let sizeInBytes = 0;
      for await (const messageData of iterator) {
        if (!messageData || !messageData.data) {
          continue;
        }

        const event = this._messageDataToMessageEvent(messageData);
        if (!event) {
          // fixme - problem?
          continue;
        }

        let events = messagesByTopic[event.topic];
        if (!events) {
          events = messagesByTopic[event.topic] = [];
        }
        sizeInBytes += messageData.data.byteLength;
        events.push(event);
      }

      const block = {
        messagesByTopic: {
          ...existingBlock?.messagesByTopic,
          ...messagesByTopic,
        },
        sizeInBytes: sizeInBytes + (existingBlock?.sizeInBytes ?? 0),
      };

      this._blocks[idx] = block;

      for (const req of this._blockRequests) {
        if (req.blockId === idx) {
          req.resolve(block);
          const removeId = this._blockRequests.indexOf(req);
          if (removeId >= 0) {
            this._blockRequests.splice(removeId, 1);
          }
        }
      }
    }
  }

  startPlayback(): void {
    if (this._isPlaying) {
      return;
    }
    this._metricsCollector.play(this._speed);
    this._isPlaying = true;
    if (this._state === "idle") {
      this._setState("play");
    }
  }

  pausePlayback(): void {
    if (!this._isPlaying) {
      return;
    }
    this._metricsCollector.pause();
    // clear out last tick millis so we don't read a huge chunk when we unpause
    this._lastTickMillis = undefined;
    this._isPlaying = false;
    if (this._state === "play") {
      this._setState("idle");
    }
  }

  setPlaybackSpeed(speed: number): void {
    delete this._lastRangeMillis;
    this._speed = speed;
    this._metricsCollector.setSpeed(speed);

    if (this._state === "idle") {
      void this._emitState();
    }
  }

  seekPlayback(time: Time): void {
    // Only seek when the provider initialization is done.
    if (this._state === "preinit" || this._state === "initialize") {
      return;
    }

    this._metricsCollector.seek(time);
    this._seekTarget = time;
    this._setState("seek-backfill");
  }

  setSubscriptions(newSubscriptions: SubscribePayload[]): void {
    this._subscriptions = newSubscriptions;
    this._metricsCollector.setSubscriptions(newSubscriptions);

    // if we are in seek backfill
    if (this._state === "idle" || this._state === "seek-backfill" || this._state === "play") {
      if (!this._isPlaying && this._currentTime) {
        this.seekPlayback(this._currentTime);
        return;
      }
    }
  }

  requestBackfill(): void {
    // no-op
  }

  setPublishers(_publishers: AdvertiseOptions[]): void {
    // no-op
  }

  setParameter(_key: string, _value: ParameterValue): void {
    throw new Error("Parameter editing is not supported by this data source");
  }

  publish(_payload: PublishPayload): void {
    throw new Error("Publishing is not supported by this data source");
  }

  close(): void {
    this._isPlaying = false;
    this._closed = true;
    this._bag = undefined;
    this._metricsCollector.close();
  }

  setGlobalVariables(): void {
    // no-op
  }
}
