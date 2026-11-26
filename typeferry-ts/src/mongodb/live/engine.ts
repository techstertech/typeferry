import type { Collection, Document } from "mongodb";
import { z } from "zod";

import { NO_CHANNEL, Presentation, ServerEvents } from "../../utils";
import {
  SocketState,
  type ClientNode,
  type Event,
  type Method,
  type Server,
} from "../../server";
import { MongoLiveObserver } from "./observer";
import {
  MongoLiveCollectionSource,
  type MongoLiveChangeSource,
} from "./source";
import {
  MONGO_LIVE_EVENT,
  MONGO_LIVE_MAX_BUFFERED_BYTES,
  MONGO_LIVE_MAX_SNAPSHOT_DOCUMENTS,
  MONGO_LIVE_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  MONGO_LIVE_MAX_WINDOW_SKIP,
  MONGO_LIVE_ORDERED_WINDOW_CAPABILITY,
  MONGO_LIVE_TYPED_OBJECT_ID_CAPABILITY,
  MONGO_LIVE_RESYNC_METHOD,
  MONGO_LIVE_SLOW_CONSUMER_GRACE_MS,
  MONGO_LIVE_SUBSCRIBE_METHOD,
  MONGO_LIVE_UNSUBSCRIBE_METHOD,
  type MongoLiveDelta,
  type MongoLiveOptions,
  type MongoLiveResyncRequest,
  type MongoLiveRuntimePublication,
  type MongoLiveSnapshot,
  type MongoLiveSubscribeRequest,
  type MongoLiveUnsubscribeRequest,
} from "./types";
import { normalizeMongoLiveWindow } from "./window";

const subscriptionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9-]+$/);

const subscribeSchema = z.object({
  subscriptionId: subscriptionIdSchema,
  publication: z.string().min(1).max(128),
  args: z.unknown(),
  capabilities: z.array(z.string().max(64)).max(16).optional(),
});

const resyncSchema = z.object({
  subscriptionId: subscriptionIdSchema,
  staleGeneration: z.string().min(1).max(64),
});

const unsubscribeSchema = z.object({
  subscriptionId: subscriptionIdSchema,
});

interface MongoLiveSubscription {
  readonly id: string;
  readonly node: ClientNode;
  readonly publication: MongoLiveRuntimePublication;
  readonly args: unknown;
  readonly authorization: AbortController;
  readonly supportsOrderedWindows: boolean;
  readonly supportsTypedObjectIds: boolean;
  observer: MongoLiveObserver;
  generation: string;
  stale: boolean;
  pressureTimer: ReturnType<typeof setTimeout> | null;
}

/** Runtime dependencies supplied by the MongoDB registry. */
export interface MongoLiveEngineDependencies {
  /** TypeFerry server receiving live RPC registrations. */
  readonly server: Server;
  /** Resolves a publication collection token to a native collection. */
  readonly resolveCollection: (
    publication: MongoLiveRuntimePublication,
  ) => Collection<Document>;
  /** Returns the stable registered collection name. */
  readonly collectionName: (publication: MongoLiveRuntimePublication) => string;
  /** Capacity and publication configuration. */
  readonly options: MongoLiveOptions;
}

/** Owns MongoDB live publications, sources, and connection subscriptions. */
export class MongoLiveEngine {
  private readonly publications = new Map<
    string,
    MongoLiveRuntimePublication
  >();
  private readonly subscriptions = new Map<
    ClientNode,
    Map<string, MongoLiveSubscription>
  >();
  private readonly sources = new Map<string, MongoLiveCollectionSource>();
  private readonly pendingAuthorizations = new Map<
    ClientNode,
    Set<AbortController>
  >();
  private readonly resyncSnapshots = new WeakMap<
    ClientNode,
    Map<string, MongoLiveSnapshot>
  >();
  private readonly nodeMutations = new WeakMap<ClientNode, Promise<void>>();
  private readonly activeMutations = new Set<Promise<unknown>>();
  private readonly ownedMethods = new Map<string, Method<z.ZodType, unknown>>();
  private ownedEvent: Event | null = null;
  private closed = false;

  private readonly maxSubscriptionsPerConnection: number;
  private readonly maxSnapshotDocuments: number;
  private readonly maxWindowSkip: number;
  private readonly maxBufferedBytes: number;
  private readonly slowConsumerGraceMs: number;

  /** Creates and atomically registers the live extension. */
  constructor(private readonly dependencies: MongoLiveEngineDependencies) {
    this.maxSubscriptionsPerConnection =
      dependencies.options.maxSubscriptionsPerConnection ??
      MONGO_LIVE_MAX_SUBSCRIPTIONS_PER_CONNECTION;
    this.maxSnapshotDocuments =
      dependencies.options.maxSnapshotDocuments ??
      MONGO_LIVE_MAX_SNAPSHOT_DOCUMENTS;
    this.maxWindowSkip =
      dependencies.options.maxWindowSkip ?? MONGO_LIVE_MAX_WINDOW_SKIP;
    this.maxBufferedBytes =
      dependencies.options.maxBufferedBytes ?? MONGO_LIVE_MAX_BUFFERED_BYTES;
    this.slowConsumerGraceMs =
      dependencies.options.slowConsumerGraceMs ??
      MONGO_LIVE_SLOW_CONSUMER_GRACE_MS;
    assertPositiveCapacity(
      "maxSubscriptionsPerConnection",
      this.maxSubscriptionsPerConnection,
    );
    assertPositiveCapacity("maxSnapshotDocuments", this.maxSnapshotDocuments);
    assertNonNegativeCapacity("maxWindowSkip", this.maxWindowSkip);
    assertNonNegativeCapacity("maxBufferedBytes", this.maxBufferedBytes);
    assertNonNegativeCapacity(
      "slowConsumerGraceMs",
      this.slowConsumerGraceMs,
    );

    for (const publication of dependencies.options.publications) {
      if (this.publications.has(publication.name)) {
        throw new Error(
          `MongoDB live publication "${publication.name}" is already registered.`,
        );
      }
      this.publications.set(publication.name, publication);
    }

    this.registerServerSurface();
  }

  /** Stops new work and releases every source, observer, and server listener. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.dependencies.server.off(
      ServerEvents.DISCONNECTION,
      this.handleDisconnection,
    );
    this.dependencies.server.off(ServerEvents.LOGOUT, this.handleLogout);

    for (const pending of this.pendingAuthorizations.values()) {
      for (const authorization of pending) authorization.abort();
    }
    await Promise.allSettled([...this.activeMutations]);
    const stops: Promise<void>[] = [];
    for (const nodeSubscriptions of this.subscriptions.values()) {
      for (const subscription of nodeSubscriptions.values()) {
        stops.push(this.stopSubscription(subscription));
      }
    }
    await Promise.all(stops);
    this.subscriptions.clear();

    await Promise.all(
      [...this.sources.values()].map((source) => source.close()),
    );
    this.sources.clear();

    for (const [name, method] of this.ownedMethods) {
      if (this.dependencies.server.methods.get(name) === method) {
        this.dependencies.server.methods.delete(name);
      }
    }
    this.ownedMethods.clear();

    if (
      this.ownedEvent &&
      this.dependencies.server.events.get(MONGO_LIVE_EVENT) === this.ownedEvent
    ) {
      this.dependencies.server.events.delete(MONGO_LIVE_EVENT);
    }
    this.ownedEvent = null;
  }

  private registerServerSurface(): void {
    const server = this.dependencies.server;
    const subscribe = (node: ClientNode, request: MongoLiveSubscribeRequest) =>
      this.serialize(node, () => this.subscribe(node, request));
    const resync = (node: ClientNode, request: MongoLiveResyncRequest) =>
      this.serialize(node, () => this.resync(node, request));
    const unsubscribe = (
      node: ClientNode,
      request: MongoLiveUnsubscribeRequest,
    ) => this.serialize(node, () => this.unsubscribe(node, request));
    const reserved = [
      MONGO_LIVE_SUBSCRIBE_METHOD,
      MONGO_LIVE_RESYNC_METHOD,
      MONGO_LIVE_UNSUBSCRIBE_METHOD,
    ];

    for (const name of reserved) {
      if (server.methods.has(name)) {
        throw new Error(`TypeFerry method "${name}" is already registered.`);
      }
    }
    if (server.events.has(MONGO_LIVE_EVENT)) {
      throw new Error(
        `TypeFerry event "${MONGO_LIVE_EVENT}" is already registered.`,
      );
    }

    server.addMethod(
      MONGO_LIVE_SUBSCRIBE_METHOD,
      async function (request: MongoLiveSubscribeRequest) {
        return subscribe(this, request);
      },
      { protected: false, schema: subscribeSchema, sensitive: true },
    );
    server.addMethod(
      MONGO_LIVE_RESYNC_METHOD,
      async function (request: MongoLiveResyncRequest) {
        return resync(this, request);
      },
      { protected: false, schema: resyncSchema, sensitive: true },
    );
    server.addMethod(
      MONGO_LIVE_UNSUBSCRIBE_METHOD,
      async function (request: MongoLiveUnsubscribeRequest) {
        return unsubscribe(this, request);
      },
      { protected: false, schema: unsubscribeSchema, sensitive: true },
    );

    for (const name of reserved) {
      const method = server.methods.get(name);
      if (method) this.ownedMethods.set(name, method);
    }

    server.addEvent(MONGO_LIVE_EVENT, {
      shouldSubscribe: async () => false,
    });
    this.ownedEvent = server.events.get(MONGO_LIVE_EVENT) ?? null;

    server.on(ServerEvents.DISCONNECTION, this.handleDisconnection);
    server.on(ServerEvents.LOGOUT, this.handleLogout);
  }

  private async subscribe(
    node: ClientNode,
    request: MongoLiveSubscribeRequest,
  ): Promise<MongoLiveSnapshot> {
    this.assertWebSocket(node);
    if (this.closed) throw new Error("MongoDB live engine is closed.");

    const publication = this.publications.get(request.publication);
    if (!publication) throw new Error("MongoDB live publication not found.");
    if (publication.protected && !node.authenticated) {
      throw new Error("MongoDB live publication forbidden.");
    }

    let nodeSubscriptions = this.subscriptions.get(node);
    if (!nodeSubscriptions) {
      nodeSubscriptions = new Map();
      this.subscriptions.set(node, nodeSubscriptions);
    }

    const existing = nodeSubscriptions.get(request.subscriptionId);
    if (existing) {
      await this.stopSubscription(existing);
      nodeSubscriptions.delete(request.subscriptionId);
    }

    if (nodeSubscriptions.size >= this.maxSubscriptionsPerConnection) {
      throw new Error("MongoDB live subscription capacity exceeded.");
    }

    const authorization = new AbortController();
    this.trackPending(node, authorization);
    let subscription: MongoLiveSubscription | null = null;
    try {
      const args = publication.parseArgs(request.args);
      const scope = await publication.authorize(
        { client: node, signal: authorization.signal },
        args,
      );
      this.assertActive(node, authorization);
      subscription = await this.createSubscription({
        id: request.subscriptionId,
        node,
        publication,
        args,
        scope,
      authorization,
      supportsOrderedWindows:
        request.capabilities?.includes(
          MONGO_LIVE_ORDERED_WINDOW_CAPABILITY,
        ) ?? false,
      supportsTypedObjectIds:
        request.capabilities?.includes(
          MONGO_LIVE_TYPED_OBJECT_ID_CAPABILITY,
        ) ?? false,
      });
      this.assertActive(node, authorization);
      const snapshot = await subscription.observer.start();
      this.assertActive(node, authorization);
      nodeSubscriptions.set(subscription.id, subscription);
      return snapshot;
    } catch (error) {
      authorization.abort();
      await subscription?.observer.stop();
      if (nodeSubscriptions.size === 0) this.subscriptions.delete(node);
      throw error;
    } finally {
      this.untrackPending(node, authorization);
    }
  }

  private async resync(
    node: ClientNode,
    request: MongoLiveResyncRequest,
  ): Promise<MongoLiveSnapshot> {
    this.assertWebSocket(node);
    const nodeSubscriptions = this.subscriptions.get(node);
    const previous = nodeSubscriptions?.get(request.subscriptionId);
    if (!previous) throw new Error("MongoDB live subscription not found.");
    if (previous.publication.protected && !node.authenticated) {
      throw new Error("MongoDB live publication forbidden.");
    }
    const resyncKey = `${request.subscriptionId}:${request.staleGeneration}`;
    const cached = this.resyncSnapshots.get(node)?.get(resyncKey);
    if (cached) return cached;

    if (previous.generation !== request.staleGeneration && !previous.stale) {
      throw new Error("MongoDB live subscription generation is current.");
    }

    const scope = await previous.publication.authorize(
      { client: node, signal: previous.authorization.signal },
      previous.args,
    );
    await previous.observer.stop();
    if (previous.pressureTimer) clearTimeout(previous.pressureTimer);

    const replacement = await this.createSubscription({
      id: previous.id,
      node,
      publication: previous.publication,
      args: previous.args,
      scope,
      authorization: previous.authorization,
      supportsOrderedWindows: previous.supportsOrderedWindows,
      supportsTypedObjectIds: previous.supportsTypedObjectIds,
    });
    try {
      const snapshot = await replacement.observer.start();
      this.assertActive(node, replacement.authorization);
      nodeSubscriptions?.set(previous.id, replacement);
      let snapshots = this.resyncSnapshots.get(node);
      if (!snapshots) {
        snapshots = new Map();
        this.resyncSnapshots.set(node, snapshots);
      }
      snapshots.clear();
      snapshots.set(resyncKey, snapshot);
      return snapshot;
    } catch (error) {
      await replacement.observer.stop();
      nodeSubscriptions?.delete(previous.id);
      throw error;
    }
  }

  private async unsubscribe(
    node: ClientNode,
    request: MongoLiveUnsubscribeRequest,
  ): Promise<boolean> {
    this.assertWebSocket(node);
    const nodeSubscriptions = this.subscriptions.get(node);
    const subscription = nodeSubscriptions?.get(request.subscriptionId);
    if (!subscription) return false;

    nodeSubscriptions?.delete(request.subscriptionId);
    await this.stopSubscription(subscription);
    if (nodeSubscriptions?.size === 0) this.subscriptions.delete(node);
    return true;
  }

  private async createSubscription(input: {
    readonly id: string;
    readonly node: ClientNode;
    readonly publication: MongoLiveRuntimePublication;
    readonly args: unknown;
    readonly scope: unknown;
    readonly authorization: AbortController;
    readonly supportsOrderedWindows: boolean;
    readonly supportsTypedObjectIds: boolean;
  }): Promise<MongoLiveSubscription> {
    const collection = this.dependencies.resolveCollection(input.publication);
    const configuredWindow = input.publication.window?.(
      input.scope,
      input.args,
    );
    const window = configuredWindow
      ? normalizeMongoLiveWindow(
          configuredWindow,
          this.maxSnapshotDocuments,
          this.maxWindowSkip,
        )
      : null;
    if (window && !input.supportsOrderedWindows) {
      throw new Error(
        "MongoDB ordered live windows require client capability negotiation.",
      );
    }
    if (window && !input.supportsTypedObjectIds) {
      throw new Error(
        "MongoDB ordered live windows require typed ObjectId capability negotiation.",
      );
    }
    const source = await this.getSource(
      input.publication,
      input.authorization.signal,
    );
    const generation = Presentation.uuid();

    const subscription = {
      id: input.id,
      node: input.node,
      publication: input.publication,
      args: input.args,
      authorization: input.authorization,
      supportsOrderedWindows: input.supportsOrderedWindows,
      supportsTypedObjectIds: input.supportsTypedObjectIds,
      observer: null as unknown as MongoLiveObserver,
      generation,
      stale: false,
      pressureTimer: null,
    } satisfies MongoLiveSubscription;

    subscription.observer = new MongoLiveObserver({
      subscriptionId: input.id,
      generation,
      collection,
      filter: input.publication.filter(input.scope, input.args),
      window,
      typedObjectIds: input.supportsTypedObjectIds,
      project: (document) => input.publication.project(document, input.scope),
      source,
      maxSnapshotDocuments: this.maxSnapshotDocuments,
      onDelta: (delta) => this.deliver(subscription, delta),
      onStale: () => this.markStale(subscription),
    });

    return subscription;
  }

  private async getSource(
    publication: MongoLiveRuntimePublication,
    signal: AbortSignal,
  ): Promise<MongoLiveChangeSource> {
    const name = this.dependencies.collectionName(publication);
    let source = this.sources.get(name);
    if (!source) {
      source = new MongoLiveCollectionSource(
        this.dependencies.resolveCollection(publication),
      );
      this.sources.set(name, source);
    }
    await Promise.race([
      source.start(),
      new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("MongoDB live subscription was cancelled."));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new Error("MongoDB live subscription was cancelled.")),
          { once: true },
        );
      }),
    ]);
    return source;
  }

  private deliver(
    subscription: MongoLiveSubscription,
    delta: MongoLiveDelta,
  ): void {
    if (subscription.stale || this.closed) return;
    if (subscription.node.bufferedBytes > this.maxBufferedBytes) {
      this.markStale(subscription);
      return;
    }

    const state = subscription.node.sendTypeFerryEvent(
      MONGO_LIVE_EVENT,
      NO_CHANNEL,
      delta,
    );
    if (!state.accepted || state.bufferedBytes > this.maxBufferedBytes) {
      this.markStale(subscription);
    }
  }

  private markStale(subscription: MongoLiveSubscription): void {
    if (subscription.stale || this.closed) return;
    subscription.stale = true;
    void subscription.observer.stop();

    const startedAt = Date.now();
    const attemptControl = (): void => {
      if (this.closed || !subscription.stale) return;
      if (subscription.node.bufferedBytes <= this.maxBufferedBytes) {
        const state = subscription.node.sendTypeFerryEvent(
          MONGO_LIVE_EVENT,
          NO_CHANNEL,
          {
            type: "resync-required",
            subscriptionId: subscription.id,
            staleGeneration: subscription.generation,
          },
        );
        if (state.accepted && state.bufferedBytes <= this.maxBufferedBytes) {
          subscription.pressureTimer = null;
          return;
        }
      }

      if (Date.now() - startedAt >= this.slowConsumerGraceMs) {
        subscription.node.socket?.close(1013, "MongoDB live resync required");
        subscription.pressureTimer = null;
        return;
      }
      subscription.pressureTimer = setTimeout(attemptControl, 100);
    };

    attemptControl();
  }

  private async stopSubscription(
    subscription: MongoLiveSubscription,
  ): Promise<void> {
    subscription.authorization.abort();
    if (subscription.pressureTimer) clearTimeout(subscription.pressureTimer);
    subscription.pressureTimer = null;
    await subscription.observer.stop();
  }

  private assertWebSocket(node: ClientNode): void {
    if (!node.socket || node.socket.readyState !== SocketState.OPEN) {
      throw new Error("MongoDB live methods require an active WebSocket.");
    }
    if (!node.supportsBufferedBytes) {
      throw new Error(
        "MongoDB live methods require WebSocket pressure reporting.",
      );
    }
  }

  private assertActive(
    node: ClientNode,
    authorization: AbortController,
  ): void {
    this.assertWebSocket(node);
    if (this.closed || authorization.signal.aborted) {
      throw new Error("MongoDB live subscription was cancelled.");
    }
  }

  private trackPending(
    node: ClientNode,
    authorization: AbortController,
  ): void {
    let pending = this.pendingAuthorizations.get(node);
    if (!pending) {
      pending = new Set();
      this.pendingAuthorizations.set(node, pending);
    }
    pending.add(authorization);
  }

  private untrackPending(
    node: ClientNode,
    authorization: AbortController,
  ): void {
    const pending = this.pendingAuthorizations.get(node);
    pending?.delete(authorization);
    if (pending?.size === 0) this.pendingAuthorizations.delete(node);
  }

  private serialize<TResult>(
    node: ClientNode,
    operation: () => Promise<TResult>,
  ): Promise<TResult> {
    const previous = this.nodeMutations.get(node) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.nodeMutations.set(node, current.then(() => undefined, () => undefined));
    this.activeMutations.add(current);
    void current.finally(() => {
      this.activeMutations.delete(current);
    }).catch(() => undefined);
    return current;
  }

  private readonly handleDisconnection = (node: ClientNode): void => {
    this.abortPending(node);
    void this.stopNode(node);
  };

  private readonly handleLogout = (node: ClientNode): void => {
    this.abortPending(node);
    void this.stopNode(node);
  };

  private abortPending(node: ClientNode): void {
    for (const authorization of this.pendingAuthorizations.get(node) ?? []) {
      authorization.abort();
    }
  }

  private async stopNode(node: ClientNode): Promise<void> {
    const nodeSubscriptions = this.subscriptions.get(node);
    if (!nodeSubscriptions) return;
    this.subscriptions.delete(node);
    this.resyncSnapshots.delete(node);
    await Promise.all(
      [...nodeSubscriptions.values()].map((subscription) =>
        this.stopSubscription(subscription),
      ),
    );
  }
}

function assertPositiveCapacity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`MongoDB live option "${name}" must be a positive integer.`);
  }
}

function assertNonNegativeCapacity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `MongoDB live option "${name}" must be a non-negative integer.`,
    );
  }
}
