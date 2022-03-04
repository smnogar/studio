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
import { isEqual, groupBy, partition } from "lodash";
import memoizeWeak from "memoize-weak";
import shallowequal from "shallowequal";
import { v4 as uuidv4 } from "uuid";

import { signal } from "@foxglove/den/async";
import Log from "@foxglove/log";
import { Time, compare } from "@foxglove/rostime";
import { ParameterValue } from "@foxglove/studio";
import { GlobalVariables } from "@foxglove/studio-base/hooks/useGlobalVariables";
import getPrettifiedCode from "@foxglove/studio-base/panels/NodePlayground/getPrettifiedCode";
import { MemoizedLibGenerator } from "@foxglove/studio-base/players/UserNodePlayer/MemoizedLibGenerator";
import { generateTypesLib } from "@foxglove/studio-base/players/UserNodePlayer/nodeTransformerWorker/generateTypesLib";
import { TransformArgs } from "@foxglove/studio-base/players/UserNodePlayer/nodeTransformerWorker/types";
import {
  Diagnostic,
  DiagnosticSeverity,
  ErrorCodes,
  NodeData,
  NodeRegistration,
  ProcessMessageOutput,
  RegistrationOutput,
  Sources,
  UserNodeLog,
} from "@foxglove/studio-base/players/UserNodePlayer/types";
import { hasTransformerErrors } from "@foxglove/studio-base/players/UserNodePlayer/utils";
import {
  AdvertiseOptions,
  Player,
  PlayerState,
  PlayerStateActiveData,
  PublishPayload,
  SubscribePayload,
  Topic,
  MessageEvent,
  PlayerProblem,
} from "@foxglove/studio-base/players/types";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import { UserNode, UserNodes } from "@foxglove/studio-base/types/panels";
import Rpc from "@foxglove/studio-base/util/Rpc";
import { basicDatatypes, foxgloveDatatypes } from "@foxglove/studio-base/util/datatypes";
import { DEFAULT_STUDIO_NODE_PREFIX } from "@foxglove/studio-base/util/globalConstants";

const log = Log.getLogger(__filename);

// TypeScript's built-in lib only accepts strings for the scriptURL. However, webpack only
// understands `new URL()` to properly build the worker entry point:
// https://github.com/webpack/webpack/issues/13043
declare let SharedWorker: {
  prototype: SharedWorker;
  new (scriptURL: URL, options?: string | WorkerOptions): SharedWorker;
};

type UserNodeActions = {
  setUserNodeDiagnostics: (nodeId: string, diagnostics: readonly Diagnostic[]) => void;
  addUserNodeLogs: (nodeId: string, logs: readonly UserNodeLog[]) => void;
  setUserNodeRosLib: (rosLib: string) => void;
  setUserNodeTypesLib: (lib: string) => void;
};

function maybePlainObject(rawVal: unknown) {
  if (typeof rawVal === "object" && rawVal && "toJSON" in rawVal) {
    return (rawVal as { toJSON: () => unknown }).toJSON();
  }
  return rawVal;
}

export default class UserNodePlayer implements Player {
  private _player: Player;

  private _nodeRegistrations: readonly NodeRegistration[] = [];
  // Datatypes and topics are derived from nodeRegistrations, but memoized so they only change when needed
  private _memoizedNodeDatatypes: readonly RosDatatypes[] = [];
  private _memoizedNodeTopics: readonly Topic[] = [];

  private _subscriptions: SubscribePayload[] = [];
  private _validTopics = new Set<string>();
  private _userNodes: UserNodes = {};

  // listener for state updates
  private _listener?: (arg0: PlayerState) => Promise<void>;

  // Not sure if there is perf issue with unused workers (may just go idle) - requires more research
  private _unusedNodeRuntimeWorkers: Rpc[] = [];
  private _lastPlayerStateActiveData?: PlayerStateActiveData;
  private _setUserNodeDiagnostics: (nodeId: string, diagnostics: readonly Diagnostic[]) => void;
  private _addUserNodeLogs: (nodeId: string, logs: UserNodeLog[]) => void;
  private _nodeTransformRpc?: Rpc;
  private _globalVariables: GlobalVariables = {};
  private _pendingResetWorkers?: Promise<void>;
  private _userNodeActions: UserNodeActions;
  private _rosLibGenerator: MemoizedLibGenerator;
  private _typesLibGenerator: MemoizedLibGenerator;

  // Player state changes when the child player invokes our player state listener
  // we may also emit state changes on internal errors
  private _playerState?: PlayerState;

  // The store tracks problems for individual userspace nodes
  // a node may set its own problem or clear its problem
  private _problemStore = new Map<string, PlayerProblem>();

  private _nodeRegistrationCache: {
    nodeId: string;
    userNode: UserNode;
    result: NodeRegistration;
  }[] = [];

  // exposed as a static to allow testing to mock/replace
  static CreateNodeTransformWorker = (): SharedWorker => {
    return new SharedWorker(new URL("./nodeTransformerWorker/index", import.meta.url), {
      // Although we are using SharedWorkers, we do not actually want to share worker instances
      // between tabs. We achieve this by passing in a unique name.
      name: uuidv4(),
    });
  };

  // exposed as a static to allow testing to mock/replace
  static CreateNodeRuntimeWorker = (): SharedWorker => {
    return new SharedWorker(new URL("./nodeRuntimeWorker/index", import.meta.url), {
      // Although we are using SharedWorkers, we do not actually want to share worker instances
      // between tabs. We achieve this by passing in a unique name.
      name: uuidv4(),
    });
  };

  constructor(player: Player, userNodeActions: UserNodeActions) {
    this._player = player;
    this._userNodeActions = userNodeActions;
    const { setUserNodeDiagnostics, addUserNodeLogs } = userNodeActions;

    this._setUserNodeDiagnostics = (nodeId: string, diagnostics: readonly Diagnostic[]) => {
      setUserNodeDiagnostics(nodeId, diagnostics);
    };
    this._addUserNodeLogs = (nodeId: string, logs: UserNodeLog[]) => {
      if (logs.length > 0) {
        addUserNodeLogs(nodeId, logs);
      }
    };

    this._typesLibGenerator = new MemoizedLibGenerator(async (args) => {
      const lib = generateTypesLib({
        topics: args.topics,
        datatypes: new Map([...basicDatatypes, ...foxgloveDatatypes, ...args.datatypes]),
      });

      return await getPrettifiedCode(lib);
    });

    this._rosLibGenerator = new MemoizedLibGenerator(async (args) => {
      const transformWorker = this._getTransformWorker();
      return await transformWorker.send("generateRosLib", {
        topics: args.topics,
        // Include basic datatypes along with any custom datatypes.
        // Custom datatypes appear as the second array items to override any basicDatatype items
        datatypes: new Map([...basicDatatypes, ...args.datatypes]),
      });
    });
  }

  private _getTopics = memoizeWeak(
    (topics: readonly Topic[], nodeTopics: readonly Topic[]): Topic[] => [...topics, ...nodeTopics],
  );

  private _getDatatypes = memoizeWeak(
    (datatypes: RosDatatypes, nodeDatatypes: readonly RosDatatypes[]): RosDatatypes => {
      return nodeDatatypes.reduce(
        (allDatatypes, userNodeDatatypes) => new Map([...allDatatypes, ...userNodeDatatypes]),
        new Map([...datatypes, ...basicDatatypes]),
      );
    },
  );

  // Basic memoization by remembering the last values passed to getMessages
  private _lastGetMessagesInput: {
    parsedMessages: readonly MessageEvent<unknown>[];
    globalVariables: GlobalVariables;
    nodeRegistrations: readonly NodeRegistration[];
  } = { parsedMessages: [], globalVariables: {}, nodeRegistrations: [] };
  private _lastGetMessagesResult: { parsedMessages: readonly MessageEvent<unknown>[] } = {
    parsedMessages: [],
  };

  // When updating nodes while paused, we seek to the current time
  // (i.e. invoke _getMessages with an empty array) to refresh messages
  private _getMessages = async (
    parsedMessages: readonly MessageEvent<unknown>[],
    globalVariables: GlobalVariables,
    nodeRegistrations: readonly NodeRegistration[],
  ): Promise<{
    parsedMessages: readonly MessageEvent<unknown>[];
  }> => {
    if (
      shallowequal(this._lastGetMessagesInput, {
        parsedMessages,
        globalVariables,
        nodeRegistrations,
      })
    ) {
      return this._lastGetMessagesResult;
    }
    const parsedMessagesPromises: Promise<MessageEvent<unknown> | undefined>[] = [];
    for (const message of parsedMessages) {
      const messagePromises = [];
      for (const nodeRegistration of nodeRegistrations) {
        if (
          this._validTopics.has(nodeRegistration.output.name) &&
          nodeRegistration.inputs.includes(message.topic)
        ) {
          const messagePromise = nodeRegistration.processMessage(message, globalVariables);
          messagePromises.push(messagePromise);
          parsedMessagesPromises.push(messagePromise);
        }
      }
      await Promise.all(messagePromises);
    }

    const nodeParsedMessages = (await Promise.all(parsedMessagesPromises)).filter(
      (value): value is MessageEvent<unknown> => value != undefined,
    );

    const result = {
      parsedMessages: parsedMessages
        .concat(nodeParsedMessages)
        .sort((a, b) => compare(a.receiveTime, b.receiveTime)),
    };
    this._lastGetMessagesInput = { parsedMessages, globalVariables, nodeRegistrations };
    this._lastGetMessagesResult = result;
    return result;
  };

  setGlobalVariables(globalVariables: GlobalVariables): void {
    this._globalVariables = globalVariables;
  }

  // Called when userNode state is updated.
  async setUserNodes(userNodes: UserNodes): Promise<void> {
    this._userNodes = userNodes;

    // Prune the node registration cache so it doesn't grow forever.
    // We add one to the count so we don't have to recompile nodes if users undo/redo node changes.
    const maxNodeRegistrationCacheCount = Object.keys(userNodes).length + 1;
    this._nodeRegistrationCache.splice(maxNodeRegistrationCacheCount);

    // This code causes us to reset workers twice because the forceSeek resets the workers too
    // TODO: Only reset workers once
    return await this._resetWorkers().then(() => {
      this.setSubscriptions(this._subscriptions);
      const { currentTime, isPlaying = false } = this._lastPlayerStateActiveData ?? {};
      if (currentTime && !isPlaying) {
        this._player.seekPlayback?.(currentTime);
      }
    });
  }

  // Defines the inputs/outputs and worker interface of a user node.
  private _createNodeRegistration = async (
    nodeId: string,
    userNode: UserNode,
  ): Promise<NodeRegistration> => {
    for (const cacheEntry of this._nodeRegistrationCache) {
      if (nodeId === cacheEntry.nodeId && isEqual(userNode, cacheEntry.userNode)) {
        return cacheEntry.result;
      }
    }
    // Pass all the nodes a set of basic datatypes that we know how to render.
    // These could be overwritten later by bag datatypes, but these datatype definitions should be very stable.
    const { topics = [], datatypes = new Map() } = this._lastPlayerStateActiveData ?? {};
    const nodeDatatypes: RosDatatypes = new Map([...basicDatatypes, ...datatypes]);

    const rosLib = await this._getRosLib();
    const typesLib = await this._getTypesLib();
    const { name, sourceCode } = userNode;
    const transformMessage: TransformArgs = {
      name,
      sourceCode,
      topics,
      rosLib,
      typesLib,
      datatypes: nodeDatatypes,
    };
    const transformWorker = this._getTransformWorker();
    const nodeData = await transformWorker.send<NodeData>("transform", transformMessage);
    const { inputTopics, outputTopic, transpiledCode, projectCode, outputDatatype } = nodeData;

    let rpc: Rpc | undefined;
    let terminateSignal = signal<void>();

    // problemKey is a unique identifier for each userspace node so we can manage problems from
    // a specific node. A node may have a problem that may later clear. Using the key we can add/remove
    // problems for specific userspace nodes independently of other userspace nodes.
    const problemKey = `node-id-${nodeId}`;

    const processMessage: NodeRegistration["processMessage"] = async (
      msgEvent,
      globalVariables,
    ): Promise<MessageEvent<unknown> | undefined> => {
      // We allow _resetWorkers to "cancel" the processing by creating a new signal every time we process a message
      terminateSignal = signal<void>();

      // Register the node within a web worker to be executed.
      if (!rpc) {
        rpc = this._unusedNodeRuntimeWorkers.pop();

        // initialize a new worker since no unused one is available
        if (!rpc) {
          const worker = UserNodePlayer.CreateNodeRuntimeWorker();

          worker.onerror = (event) => {
            log.error(event);

            this._problemStore.set(problemKey, {
              message: `Node playground runtime error: ${event.message}`,
              severity: "error",
            });

            // trigger listener updates
            void this._emitState();
          };

          const port: MessagePort = worker.port;
          port.onmessageerror = (event) => {
            log.error(event);

            this._problemStore.set(problemKey, {
              severity: "error",
              message: `Node playground runtime error: ${String(event.data)}`,
            });

            void this._emitState();
          };
          port.start();
          rpc = new Rpc(port);

          rpc.receive("error", (msg) => {
            log.error(msg);

            this._problemStore.set(problemKey, {
              severity: "error",
              message: `Node playground runtime error: ${msg}`,
            });

            void this._emitState();
          });
        }

        const { error, userNodeDiagnostics, userNodeLogs } = await rpc.send<RegistrationOutput>(
          "registerNode",
          {
            projectCode,
            nodeCode: transpiledCode,
          },
        );
        if (error != undefined) {
          this._setUserNodeDiagnostics(nodeId, [
            ...userNodeDiagnostics,
            {
              source: Sources.Runtime,
              severity: DiagnosticSeverity.Error,
              message: error,
              code: ErrorCodes.RUNTIME,
            },
          ]);
          return;
        }
        this._addUserNodeLogs(nodeId, userNodeLogs);
      }

      // To send the message over RPC we invoke maybePlainObject which calls toJSON on the message
      // and builds a plain js object of the entire message. This is expensive so a future enhancement
      // would be to send the underlying message array and build a lazy message reader
      const result = await Promise.race([
        rpc.send<ProcessMessageOutput>("processMessage", {
          message: {
            topic: msgEvent.topic,
            receiveTime: msgEvent.receiveTime,
            message: maybePlainObject(msgEvent.message),
          },
          globalVariables,
        }),
        terminateSignal,
      ]);

      if (!result) {
        this._problemStore.set(problemKey, {
          message: `Node playground node ${nodeId} timed out`,
          severity: "warn",
        });
        return;
      }

      const diagnostics =
        result.error != undefined
          ? [
              {
                source: Sources.Runtime,
                severity: DiagnosticSeverity.Error,
                message: result.error,
                code: ErrorCodes.RUNTIME,
              },
            ]
          : [];
      if (diagnostics.length > 0) {
        this._setUserNodeDiagnostics(nodeId, diagnostics);
      }
      this._addUserNodeLogs(nodeId, result.userNodeLogs);

      if (!result.message) {
        this._problemStore.set(problemKey, {
          severity: "warn",
          message: `Node playground node ${nodeId} did not produce a message`,
        });
        return;
      }

      // At this point we've received a message successfully from the userspace node, therefore
      // we clear any previous problem from this node.
      this._problemStore.delete(problemKey);

      return {
        topic: outputTopic,
        receiveTime: msgEvent.receiveTime,
        message: result.message,
        sizeInBytes: msgEvent.sizeInBytes,
      };
    };

    const terminate = () => {
      this._problemStore.delete(problemKey);

      terminateSignal.resolve();
      if (rpc) {
        this._unusedNodeRuntimeWorkers.push(rpc);
        rpc = undefined;
      }
    };

    const result = {
      nodeId,
      nodeData,
      inputs: inputTopics,
      output: { name: outputTopic, datatype: outputDatatype },
      processMessage,
      terminate,
    };
    this._nodeRegistrationCache.push({ nodeId, userNode, result });
    return result;
  };

  private _getTransformWorker(): Rpc {
    if (!this._nodeTransformRpc) {
      const worker = UserNodePlayer.CreateNodeTransformWorker();

      // The errors below persist for the lifetime of the player.
      // They are not cleared because they are irrecoverable.

      worker.onerror = (event) => {
        log.error(event);

        this._problemStore.set("worker-error", {
          severity: "error",
          message: `Node playground error: ${event.message}`,
        });

        void this._emitState();
      };

      const port: MessagePort = worker.port;
      port.onmessageerror = (event) => {
        log.error(event);

        this._problemStore.set("worker-error", {
          severity: "error",
          message: `Node playground error: ${String(event.data)}`,
        });

        void this._emitState();
      };
      port.start();
      const rpc = new Rpc(port);

      rpc.receive("error", (msg) => {
        log.error(msg);

        this._problemStore.set("worker-error", {
          severity: "error",
          message: `Node playground error: ${msg}`,
        });

        void this._emitState();
      });

      this._nodeTransformRpc = rpc;
    }
    return this._nodeTransformRpc;
  }

  // We need to reset workers in a variety of circumstances:
  // - When a user node is updated, added or deleted
  // - When we seek (in order to reset state)
  // - When a new child player is added
  //
  // For the time being, resetWorkers is a catchall for these circumstances. As
  // performance bottlenecks are identified, it will be subject to change.
  private async _resetWorkers(): Promise<void> {
    if (!this._lastPlayerStateActiveData) {
      return;
    }

    // Make sure that we only run this function once at a time, but using this instead of `debouncePromise` so that it
    // returns a promise.
    if (this._pendingResetWorkers) {
      await this._pendingResetWorkers;
    }
    const pending = signal();
    this._pendingResetWorkers = pending;

    // This early return is an optimization measure so that the
    // `nodeRegistrations` array is not re-defined, which will invalidate
    // downstream caches. (i.e. `this._getTopics`)
    if (this._nodeRegistrations.length === 0 && Object.entries(this._userNodes).length === 0) {
      pending.resolve();
      this._pendingResetWorkers = undefined;
      return;
    }

    for (const nodeRegistration of this._nodeRegistrations) {
      nodeRegistration.terminate();
    }

    const allNodeRegistrations = await Promise.all(
      Object.entries(this._userNodes).map(
        async ([nodeId, userNode]) => await this._createNodeRegistration(nodeId, userNode),
      ),
    );

    // Filter out nodes with compilation errors
    const nodeRegistrations: Array<NodeRegistration> = allNodeRegistrations.filter(
      ({ nodeData, nodeId }) => {
        const hasError = hasTransformerErrors(nodeData);
        if (hasError) {
          this._setUserNodeDiagnostics(nodeId, nodeData.diagnostics);
        }
        return !hasError;
      },
    );

    // Create diagnostic errors if more than one node outputs to the same topic
    const nodesByOutputTopic = groupBy(nodeRegistrations, ({ output }) => output.name);
    const [validNodeRegistrations, duplicateNodeRegistrations] = partition(
      nodeRegistrations,
      (nodeReg) => nodeReg === nodesByOutputTopic[nodeReg.output.name]?.[0],
    );
    duplicateNodeRegistrations.forEach(({ nodeId, nodeData }) => {
      this._setUserNodeDiagnostics(nodeId, [
        ...nodeData.diagnostics,
        {
          severity: DiagnosticSeverity.Error,
          message: `Output "${nodeData.outputTopic}" must be unique`,
          source: Sources.OutputTopicChecker,
          code: ErrorCodes.OutputTopicChecker.NOT_UNIQUE,
        },
      ]);
    });

    this._nodeRegistrations = validNodeRegistrations;
    const nodeTopics = this._nodeRegistrations.map(({ output }) => output);
    if (!isEqual(nodeTopics, this._memoizedNodeTopics)) {
      this._memoizedNodeTopics = nodeTopics;
    }
    const nodeDatatypes = this._nodeRegistrations.map(({ nodeData: { datatypes } }) => datatypes);
    if (!isEqual(nodeDatatypes, this._memoizedNodeDatatypes)) {
      this._memoizedNodeDatatypes = nodeDatatypes;
    }

    this._nodeRegistrations.forEach(({ nodeId }) => this._setUserNodeDiagnostics(nodeId, []));

    this._pendingResetWorkers = undefined;
    pending.resolve();
  }

  private async _getRosLib(): Promise<string> {
    if (!this._lastPlayerStateActiveData) {
      throw new Error("_getRosLib was called before `_lastPlayerStateActiveData` set");
    }

    const { topics, datatypes } = this._lastPlayerStateActiveData;
    const { didUpdate, lib } = await this._rosLibGenerator.update({ topics, datatypes });
    if (didUpdate) {
      this._userNodeActions.setUserNodeRosLib(lib);
    }

    return lib;
  }

  private async _getTypesLib(): Promise<string> {
    if (!this._lastPlayerStateActiveData) {
      throw new Error("_getTypesLib was called before `_lastPlayerStateActiveData` set");
    }

    const { topics, datatypes } = this._lastPlayerStateActiveData;
    const { didUpdate, lib } = await this._typesLibGenerator.update({ topics, datatypes });
    if (didUpdate) {
      this._userNodeActions.setUserNodeTypesLib(lib);
    }

    return lib;
  }

  // invoked when our child player state changes
  private async _onPlayerState(playerState: PlayerState) {
    try {
      const globalVariables = this._globalVariables;
      const { activeData } = playerState;
      if (!activeData) {
        this._playerState = playerState;
        await this._emitState();
        return;
      }

      const { messages, topics, datatypes } = activeData;

      // If we do not have active player data from a previous call, then our
      // player just spun up, meaning we should re-run our user nodes in case
      // they have inputs that now exist in the current player context.
      if (!this._lastPlayerStateActiveData) {
        this._lastPlayerStateActiveData = activeData;
        await this._resetWorkers();
        this.setSubscriptions(this._subscriptions);
        this.requestBackfill();
      } else {
        // Reset node state after seeking
        let shouldReset = activeData.lastSeekTime !== this._lastPlayerStateActiveData.lastSeekTime;

        // When topics or datatypes change we also need to re-build the nodes so we clear the cache
        if (
          activeData.topics !== this._lastPlayerStateActiveData.topics ||
          activeData.datatypes !== this._lastPlayerStateActiveData.datatypes
        ) {
          shouldReset ||= true;
          this._nodeRegistrationCache = [];
        }

        this._lastPlayerStateActiveData = activeData;
        if (shouldReset) {
          await this._resetWorkers();
        }
      }

      const allDatatypes = this._getDatatypes(datatypes, this._memoizedNodeDatatypes);

      const { parsedMessages } = await this._getMessages(
        messages,
        globalVariables,
        this._nodeRegistrations,
      );

      const newPlayerState = {
        ...playerState,
        activeData: {
          ...activeData,
          messages: parsedMessages,
          topics: this._getTopics(topics, this._memoizedNodeTopics),
          datatypes: allDatatypes,
        },
      };

      this._playerState = newPlayerState;

      // clear any previous problem we had from making a new player state
      this._problemStore.delete("player-state-update");
    } catch (err) {
      this._problemStore.set("player-state-update", {
        severity: "error",
        message: err.message,
        error: err,
      });

      this._playerState = playerState;
    } finally {
      await this._emitState();
    }
  }

  private async _emitState() {
    if (!this._playerState) {
      return;
    }

    // only augment child problems if we have our own problems
    // if neither child or parent have problems we do nothing
    let problems = this._playerState.problems;
    if (this._problemStore.size > 0) {
      problems = (problems ?? []).concat(Array.from(this._problemStore.values()));
    }

    const playerState: PlayerState = {
      ...this._playerState,
      problems,
    };

    if (this._listener) {
      await this._listener(playerState);
    }
  }

  setListener(listener: NonNullable<UserNodePlayer["_listener"]>): void {
    this._listener = listener;

    // Delay _player.setListener until our setListener is called because setListener in some cases
    // triggers initialization logic and remote requests. This is an unfortunate API behavior and
    // naming choice, but it's better for us not to do trigger this logic in the constructor.
    this._player.setListener(async (state) => await this._onPlayerState(state));
  }

  setSubscriptions(subscriptions: SubscribePayload[]): void {
    this._subscriptions = subscriptions;

    const mappedTopics: string[] = [];
    const realTopicSubscriptions: SubscribePayload[] = [];
    const nodeSubscriptions: SubscribePayload[] = [];
    for (const subscription of subscriptions) {
      // For performance, only check topics that start with DEFAULT_STUDIO_NODE_PREFIX.
      if (!subscription.topic.startsWith(DEFAULT_STUDIO_NODE_PREFIX)) {
        realTopicSubscriptions.push(subscription);
        continue;
      }

      nodeSubscriptions.push(subscription);

      // When subscribing to the same node multiple times, only subscribe to the underlying
      // topics once. This is not strictly necessary, but it makes debugging a bit easier.
      if (mappedTopics.includes(subscription.topic)) {
        continue;
      }
      mappedTopics.push(subscription.topic);

      const nodeRegistration = this._nodeRegistrations.find(
        (info) => info.output.name === subscription.topic,
      );
      if (nodeRegistration) {
        for (const inputTopic of nodeRegistration.inputs) {
          realTopicSubscriptions.push({
            topic: inputTopic,
            requester: { type: "node", name: nodeRegistration.output.name },
          });
        }
      }
    }

    this._validTopics = new Set(nodeSubscriptions.map((sub) => sub.topic));
    this._player.setSubscriptions(realTopicSubscriptions);
  }

  close = (): void => {
    for (const nodeRegistration of this._nodeRegistrations) {
      nodeRegistration.terminate();
    }
    this._player.close();
    if (this._nodeTransformRpc) {
      void this._nodeTransformRpc.send("close");
    }
  };

  setPublishers = (publishers: AdvertiseOptions[]): void => this._player.setPublishers(publishers);
  setParameter = (key: string, value: ParameterValue): void =>
    this._player.setParameter(key, value);
  publish = (request: PublishPayload): void => this._player.publish(request);
  startPlayback = (): void => this._player.startPlayback?.();
  pausePlayback = (): void => this._player.pausePlayback?.();
  setPlaybackSpeed = (speed: number): void => this._player.setPlaybackSpeed?.(speed);
  seekPlayback = (time: Time, backfillDuration?: Time): void =>
    this._player.seekPlayback?.(time, backfillDuration);
  requestBackfill = (): void => this._player.requestBackfill();
}
