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

import { Bag } from "@foxglove/rosbag";
import { BlobReader } from "@foxglove/rosbag/web";
import { parse as parseMessageDefinition } from "@foxglove/rosmsg";
import { LazyMessageReader } from "@foxglove/rosmsg-serialization";
import { Time, add, compare, clampTime, fromMillis, fromNanoSec } from "@foxglove/rostime";
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
import { Connection } from "@foxglove/studio-base/randomAccessDataProviders/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import debouncePromise from "@foxglove/studio-base/util/debouncePromise";
import delay from "@foxglove/studio-base/util/delay";
import { SEEK_ON_START_NS, TimestampMethod } from "@foxglove/studio-base/util/time";

export const DEFAULT_SEEK_BACK_NANOSECONDS = BigInt(2.5e9);

// Amount to wait until panels have had the chance to subscribe to topics before
// we start playback
export const SEEK_START_DELAY_MS = 100;

export type BagPlayerOptions = {
  metricsCollector?: PlayerMetricsCollectorInterface;

  // Optional player name
  file: File;

  // Optional set of key/values to store with url handling
  urlParams?: Record<string, string>;

  isSampleDataSource?: boolean;
};

// A `Player` that wraps around a tree of `RandomAccessDataProviders`.
export default class BagPlayer implements Player {
  private _urlParams?: Record<string, string>;
  private _name?: string;
  private _filePath?: string;
  private _isPlaying: boolean = false;
  private _listener?: (playerState: PlayerState) => Promise<void>;
  private _speed: number = 0.2;
  private _start: Time = { sec: 0, nsec: 0 };
  private _end: Time = { sec: 0, nsec: 0 };
  // next read start time indicates where to start reading for the next tick
  // after a tick read, it is set to 1nsec past the end of the read operation (preparing for the next tick)
  private _lastTickMillis?: number;
  // The last time a "seek" was started. This is used to cancel async operations, such as seeks or ticks, when a seek
  // happens while they are ocurring.
  private _lastSeekStartTime: number = Date.now();
  // This is the "lastSeekTime" emitted in the playerState. It is not the same as the _lastSeekStartTime because we can
  // start a seek and not end up emitting it, or emit something else while we are requesting messages for the seek. The
  // RandomAccessDataProvider's `progressCallback` can cause an emit at any time, for example.
  // We only want to set the "lastSeekTime" exactly when we emit the messages coming from the seek.
  private _lastSeekEmitTime: number = this._lastSeekStartTime;
  private _cancelSeekBackfill: boolean = false;
  private _providerTopics: Topic[] = [];
  private _providerDatatypes: RosDatatypes = new Map();

  // fixme - we can remove this from random access player too
  // private _providerParameters: Map<string, ParameterValue> | undefined;

  private _capabilities: string[] = [
    PlayerCapabilities.setSpeed,
    PlayerCapabilities.playbackControl,
  ];
  private _metricsCollector: PlayerMetricsCollectorInterface;
  private _subscriptions: SubscribePayload[] = [];

  // fixme - we do not need both of these!!
  private _initializing: boolean = true;
  private _initialized: boolean = false;

  private _reconnecting: boolean = false;
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

  // To keep reference equality for downstream user memoization cache the currentTime provided in the last activeData update
  // See additional comments below where _currentTime is set
  private _currentTime?: Time;

  // The problem store holds problems based on keys (which may be hard-coded problem types or topics)
  // The overall player may be healthy, but individual topics may have warnings or errors.
  // These are set/cleared in the store to track the current set of problems
  private _problems = new Map<string, PlayerProblem>();

  constructor(options: BagPlayerOptions) {
    const { metricsCollector, urlParams, file } = options;

    this._name = file.name;
    this._file = file;
    this._urlParams = urlParams;
    this._metricsCollector = metricsCollector ?? new NoopMetricsCollector();
    this._metricsCollector.playerConstructed();
    this._isSampleDataSource = options.isSampleDataSource ?? false;
  }

  private _setError(message: string, error?: Error): void {
    this._hasError = true;
    this._problems.set("global-error", {
      severity: "error",
      message,
      error,
    });
    this._isPlaying = false;
    if (!this._initializing) {
      this._bag = undefined;
    }
    this._emitState();
  }

  async initialize(): Promise<void> {
    try {
      this._bag = new Bag(new BlobReader(this._file));
      await this._bag.open();

      /*
      const chunksOverlapCount = getBagChunksOverlapCount(chunkInfos);
    // If >25% of the chunks overlap, show a warning. It's common for a small number of chunks to overlap
    // since it looks like `rosbag record` has a bit of a race condition, and that's not too terrible, so
    // only warn when there's a more serious slowdown.
    if (chunksOverlapCount > chunkInfos.length * 0.25) {
      sendNotification(
        "Bag is unsorted, which is slow",
        `This bag has many overlapping chunks (${chunksOverlapCount} out of ${chunkInfos.length}), which means that we have to decompress many chunks in order to load a particular time range. This is slow. Ideally, fix this where you're generating your bags, by sorting the messages by receive time, e.g. using a script like this: https://gist.github.com/janpaul123/deaa92338d5e8309ef7aa7a55d625152`,
        "user",
        "warn",
      );
    }
*/

      this._start = this._currentTime = this._bag.startTime ?? { sec: 0, nsec: 0 };
      this._end = this._bag.endTime ?? { sec: 0, nsec: 0 };

      this._providerTopics = [];
      for (const [id, connection] of this._bag.connections) {
        const datatype = connection.type;
        if (!datatype) {
          continue;
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
    } catch (error) {
      this._setError(`Error initializing bag: ${error.message}`, error);
    }

    const initialTime = clampTime(
      add(this._start, fromNanoSec(SEEK_ON_START_NS)),
      this._start,
      this._end,
    );

    // emit
    this._initializing = false;
    this._initialized = true;
    this._emitState();

    // Wait a bit until panels have had the chance to subscribe to topics before we start
    // playback.
    setTimeout(() => {
      if (this._closed) {
        return;
      }
      // Only do the initial seek if we haven't started playing already.
      //if (!this._isPlaying && areEqual(this._nextReadStartTime, initialTime)) {
      this.seekPlayback(initialTime);
      //}
    }, SEEK_START_DELAY_MS);

    // fixme - we should instead play up to seek_on_start_ns
    // do this after panels have subscribed
  }

  setListener(listener: (playerState: PlayerState) => Promise<void>): void {
    this._listener = listener;
    this._emitState();

    void this.initialize();
  }

  // Potentially performance-sensitive; await can be expensive
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  private _emitState = debouncePromise(() => {
    if (!this._listener) {
      return Promise.resolve();
    }

    if (this._hasError) {
      return this._listener({
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
    if (messages.length > 0) {
      // If we're outputting any messages, we need to cancel any in-progress backfills. Otherwise
      // we'd be "traveling back in time".
      this._cancelSeekBackfill = true;
    }

    /*
    // _nextReadStartTime points to the start of the _next_ range we want to read
    // for our player state, we want to have currentTime represent the last time of the range we read
    // It would be weird to provide a currentTime outside the bounds of what we read
    let lastEnd = this._nextReadStartTime;
    if (lastEnd.sec > 0 || lastEnd.nsec > 0) {
      lastEnd = add(lastEnd, { sec: 0, nsec: -1 });
    }
    */

    /*
    const publishedTopics = new Map<string, Set<string>>();
    for (const conn of this._providerConnections) {
      let publishers = publishedTopics.get(conn.topic);
      if (publishers == undefined) {
        publishers = new Set<string>();
        publishedTopics.set(conn.topic, publishers);
      }
      publishers.add(conn.callerid);
    }
    */

    // Downstream consumers of activeData rely on fields maintaining reference stability to detect changes
    // lastEnd is not stable due to the above TimeUtil.add which returns a new lastEnd value on ever call
    // Here we check if lastEnd is the same as the currentTime we've already set and avoid assigning
    // a new reference value to current time if the underlying time value is unchanged
    //const clampedLastEnd = clampTime(lastEnd, this._start, this._end);
    //if (!this._currentTime || compare(this._currentTime, clampedLastEnd) !== 0) {
    //  this._currentTime = clampedLastEnd;
    //}

    const currentTime = this._currentTime ?? this._start;

    const data: PlayerState = {
      name: this._name,
      filePath: this._filePath,
      presence: this._reconnecting
        ? PlayerPresence.RECONNECTING
        : this._initializing
        ? PlayerPresence.INITIALIZING
        : PlayerPresence.PRESENT,
      progress: this._progress,
      capabilities: this._capabilities,
      playerId: this._id,
      problems: this._problems.size > 0 ? Array.from(this._problems.values()) : undefined,
      activeData: this._initializing
        ? undefined
        : {
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
            // fixme - do we need this?
            // this is for the topic graph display, its the published topics
            //publishedTopics,
            parsedMessageDefinitionsByTopic: this._parsedMessageDefinitionsByTopic,
          },
      urlState: this._urlParams,
    };

    return this._listener(data);
  });

  private async _tick(): Promise<void> {
    if (this._initializing || !this._isPlaying || this._hasError) {
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

    // fixme - why 300ms? this is made up
    // Read at most 300ms worth of messages, otherwise things can get out of control if rendering
    // is very slow. Also, smooth over the range that we request, so that a single slow frame won't
    // cause the next frame to also be unnecessarily slow by increasing the frame size.
    let rangeMillis = Math.min(durationMillis * this._speed, 300);
    if (this._lastRangeMillis != undefined) {
      rangeMillis = this._lastRangeMillis * 0.9 + rangeMillis * 0.1;
    }
    this._lastRangeMillis = rangeMillis;

    // fixme - this lets us know if we seeked during playback
    const seekTime = this._lastSeekStartTime;

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

    for (;;) {
      const message = await this._forwardIterator.next();
      if (!message || !message.data) {
        // end of stream
        console.log("end of stream...?");
        break;
      }

      // fixme - check if we paused or if we seeked here

      const reader = this._readersByConnectionId.get(message.conn);
      if (!reader) {
        // fixme? notice?
        continue;
      }

      const topic = this._topicsByConnectionId.get(message.conn);
      if (!topic) {
        // fixme? notice
        continue;
      }

      const parsedMessage = reader.readMessage(message.data);

      const event: MessageEvent<unknown> = {
        topic,
        receiveTime: message.time,
        message: parsedMessage,
        sizeInBytes: message.data.length,
      };

      // The message is past the end time, we need to save it for next tick
      if (compare(event.receiveTime, end) > 0) {
        this._lastMessage = event;
        break;
      }

      messages.push(event);
    }

    // fixme - what is this?
    await this._emitState.currentPromise;

    // if we seeked while reading then do not emit messages
    // just start reading again from the new seek position
    if (this._lastSeekStartTime !== seekTime) {
      return;
    }

    // if we paused while reading then do not emit messages
    // and exit the read loop
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!this._isPlaying) {
      return;
    }

    // fixme - is it right to use the end time here?
    // or should this be the time of the last message?
    this._currentTime = end;

    this._messages = messages;
    this._emitState();
  }

  private _play = debouncePromise(async () => {
    // fixme - if already playing - should not do anything again!

    try {
      while (this._isPlaying && !this._hasError) {
        const start = Date.now();
        await this._tick();
        const time = Date.now() - start;
        // make sure we've slept at least 16 millis or so (aprox 1 frame)
        // to give the UI some time to breathe and not burn in a tight loop
        if (time < 16) {
          await delay(16 - time);
        }
      }
    } catch (err) {
      this._setError((err as Error).message, err);
    }
  });

  /*
  // fixme - port problems arrays
  private async _getMessages(
    start: Time,
    end: Time,
  ): Promise<{ parsedMessages: MessageEvent<unknown>[] }> {
    const parsedTopics = getSanitizedTopics(this._parsedSubscribedTopics, this._providerTopics);
    if (parsedTopics.length === 0) {
      return { parsedMessages: [] };
    }
    if (!this.hasCachedRange(start, end)) {
      this._metricsCollector.recordUncachedRangeRequest();
    }
    const { parsedMessages, problems } = await this._provider.getMessages(start, end, {
      parsedMessages: parsedTopics,
    });
    if (problems) {
      for (const problem of problems) {
        // The data provider getMessages() API does not provide a way to replace or clear problems,
        // so we give each one a unique id. If this becomes annoying to users we can consider adding
        // a way to manually or automatically clear out the list.
        this._problems.set(uuidv4(), problem);
      }
    }
    if (parsedMessages == undefined) {
      this._problems.set("bad-messages", {
        severity: "error",
        message: `Bad set of messages`,
        tip: `Restart the app or contact support if the issue persists.`,
      });
      return { parsedMessages: [] };
    }
    this._problems.delete("bad-messages");

    // It is very important that we record first emitted messages here, since
    // `_emitState` is awaited on `requestAnimationFrame`, which will not be
    // invoked unless a user's browser is focused on the current session's tab.
    // Moreover, there is a disproportionally small amount of time between when we procure
    // messages here and when they are set to playerState.
    if (parsedMessages.length > 0) {
      this._metricsCollector.recordTimeToFirstMsgs();
    }
    const filterMessages = (
      msgs: readonly MessageEvent<unknown>[],
      topics: string[],
    ): MessageEvent<unknown>[] =>
      filterMap(msgs, (message) => {
        this._problems.delete(message.topic);

        if (!topics.includes(message.topic)) {
          this._problems.set(message.topic, {
            severity: "warn",
            message: `Unexpected topic encountered: ${message.topic}. Skipping message`,
          });
          return undefined;
        }
        const topic = this._providerTopics.find((t) => t.name === message.topic);
        if (!topic) {
          this._problems.set(message.topic, {
            severity: "warn",
            message: `Unexpected message on topic: ${message.topic}. Skipping message`,
          });
          return undefined;
        }
        if (topic.datatype === "") {
          this._problems.set(message.topic, {
            severity: "warn",
            message: `Missing datatype for topic: ${message.topic}. Skipping message`,
          });
          return undefined;
        }

        return {
          topic: message.topic,
          receiveTime: message.receiveTime,
          message: message.message,
          sizeInBytes: message.sizeInBytes,
        };
      });
    return {
      parsedMessages: filterMessages(parsedMessages, parsedTopics),
    };
  }
  */

  startPlayback(): void {
    if (this._isPlaying) {
      return;
    }
    this._metricsCollector.play(this._speed);
    this._isPlaying = true;
    // fixme - why emit state here not in _play?
    this._emitState();
    this._play();
  }

  pausePlayback(): void {
    if (!this._isPlaying) {
      return;
    }
    this._metricsCollector.pause();
    // clear out last tick millis so we don't read a huge chunk when we unpause
    this._lastTickMillis = undefined;
    this._isPlaying = false;
    this._emitState();
  }

  setPlaybackSpeed(speed: number): void {
    delete this._lastRangeMillis;
    this._speed = speed;
    this._metricsCollector.setSpeed(speed);
    this._emitState();
  }

  seekPlayback(time: Time, backfillDuration?: Time): void {
    // Only seek when the provider initialization is done.
    if (!this._initialized) {
      return;
    }

    this._metricsCollector.seek(time);

    console.log("seek playback", { time });
    // fixme - need to seek

    // fixme - need to cancel any other backfill that might be happening
    // also need to pause playback to do the backfill, then resume

    // load the last message of every topic
    // fixme - set the player into "seek (backfill?) mode" instead of this
    const foo = async () => {
      const topics = new Set(this._subscriptions.map((subscription) => subscription.topic));

      this._messages = [];
      for (const topic of topics) {
        const topicIterator = this._bag.reverseIterator({ topics: [topic], timestamp: time });
        const message = await topicIterator.next();
        if (!message || !message.data) {
          continue;
        }
        const reader = this._readersByConnectionId.get(message.conn);
        if (!reader) {
          continue;
        }
        const parsed = reader.readMessage(message.data);
        const event: MessageEvent<unknown> = {
          topic,
          receiveTime: message.time,
          message: parsed,
          sizeInBytes: message.data.length,
        };
        this._messages.push(event);
      }

      // should this be the last message or the time the user seek'd to?
      this._currentTime = time;
      this._emitState();

      console.log({ topics, time });

      // create a new forward iterator for the time from now
      // fixme - should this be one nanosecond later cause we've backfilled anything at the time?
      // or should backfill be 1 nanosecond earlier?
      this._forwardIterator = this._bag?.forwardIterator({
        topics: Array.from(topics),
        timestamp: time,
      });
    };

    foo();
  }

  setSubscriptions(newSubscriptions: SubscribePayload[]): void {
    // fixme - re-load messages?
    this._subscriptions = newSubscriptions;
    this._metricsCollector.setSubscriptions(newSubscriptions);
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
