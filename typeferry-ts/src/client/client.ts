import isEqual from 'fast-deep-equal'
import qs from 'query-string'

import { isEmpty, isPlainObject, merge } from '../utils/lodash'

import type { CallOptions, MethodParams, ServerMethods } from '../utils'
import {
  TypeFerryEvents,
  ClientEvents,
  Environment,
  Errors,
  Methods,
  NO_CHANNEL,
  PayloadType,
  Presentation,
  TOKEN_HEADER_KEY,
} from '../utils'
import { callMethodProxy } from './call-method-proxy'
import { ClientChannel } from './client-channel'
import { ClientHttp } from './client-http'
import type { BackendOrigins, HttpFetch } from './backend-origin'
import { ClientSocket } from './client-socket'
import type { TypeFerryContext } from './context-manager'
import { ContextManager } from './context-manager'
import { IdleTimer } from './idle-timer'
import type { TypeFerryLogger } from './logger'
import { logger, LogLevel } from './logger'
import { VisibilityManager } from './visibility-manager'
import { DEFAULT_REQUEST_TIMEOUT_MS, RequestLifetime } from './request-lifetime'
type Timeout = ReturnType<typeof setTimeout>

export type ErrorHandler = (error: unknown) => unknown

export type WebSocketOptions = {
  path?: string

  /**
   * Workaround for Safari not reconnecting after the app is brought back to the foreground.
   */
  disconnectOnPageHide?: boolean
}

export type WebSocketRequestParams = {
  [key: string]: unknown
}

/**
 * Describes a logical RPC before its transport or credentials are captured.
 */
export type DispatchRequest = {
  readonly client: Client
  readonly method: string
  readonly kind: 'call' | 'void'
  readonly deadline: number
  readonly signal: AbortSignal
}

/**
 * An application session signal invalidates dispatch and obsolete completion.
 */
export type DispatchAdmission = {
  readonly signal?: AbortSignal
}

export type ClientOptions = {
  /**
   * Optional application admission policy, awaited before an RPC sends.
   * Credential changes during admission cause a bounded recheck without sending.
   * Control/public methods needed by recovery must be admitted without waiting.
   */
  beforeDispatch?: (
    request: DispatchRequest,
  ) => DispatchAdmission | void | Promise<DispatchAdmission | void>

  /**
   * Explicit backend origins take precedence over host, port, httpPort and secure.
   */
  backend?: BackendOrigins
  /**
   * Optional HTTP transport for native cookie storage. Web clients use fetch.
   */
  httpFetch?: HttpFetch
  host?: string
  port?: number
  /**
   * Port for HTTP requests (login, refresh). When omitted, falls back
   * to `port`. Leave undefined in dev so HTTP goes through Vite's proxy
   * (same origin as page), ensuring HttpOnly cookies work correctly.
   */
  httpPort?: number | undefined
  secure?: boolean
  ws?: WebSocketOptions
  errorHandler?: ErrorHandler
  /** @deprecated Use logLevel instead */
  debug?: boolean
  /** Log level for the client (default: WARN) */
  logLevel?: LogLevel
  allowedContextKeys?: string[]
  meta?: Record<string, unknown>
  idlenessTimeout?: number
  /**
   * Initial context to set before the first WebSocket connection.
   * With native WebSocket, auth data is sent as query parameters during
   * connection — the token must be available at socket creation time.
   */
  initialContext?: Record<string, unknown>
}

export type ProxyMethodCall = { [key: string]: ProxyMethodCall } & (<
  T = unknown,
  R = unknown,
>(
  params?: MethodParams<T>,
  options?: CallOptions,
) => Promise<R>)

/**
 * When working with Next.js, it is probably a good idea to not run this in the
 * server side by using it inside a `useEffect` hook.
 */
export class Client<
  MethodsType extends ServerMethods = ServerMethods,
> extends ClientChannel {
  uuid: string

  clientSocket: ClientSocket
  clientHttp: ClientHttp
  contextManager: ContextManager
  errorHandler: ErrorHandler | null | undefined

  channels: Map<string, ClientChannel> = new Map()

  timeouts: Set<Timeout> = new Set()

  private readonly requests = new Set<RequestLifetime>()

  initialized = false

  authenticated = false

  options: ClientOptions = {
    host: 'localhost',
    secure: false,
    debug: false,
    logLevel: LogLevel.WARN,
    allowedContextKeys: [],
    meta: {},
  }

  /** Logger instance for this client */
  logger: TypeFerryLogger = logger

  initializing = false

  visibilityManager: VisibilityManager
  idleTimer: IdleTimer | null = null

  m: MethodsType

  // Note: Heartbeat is handled by application-level ping/pong in the WebSocket transport

  get context(): TypeFerryContext {
    return this.contextManager.context
  }

  set context(value: TypeFerryContext) {
    this.contextManager.context = value
  }

  constructor(options: ClientOptions = {}) {
    super(NO_CHANNEL)

    this.m = callMethodProxy(this) as unknown as MethodsType

    this.uuid = Presentation.uuid()

    this.setClient(this)

    this.options = merge(this.options, options)
    this.errorHandler = this.options.errorHandler

    const storage =
      typeof localStorage !== 'undefined' ? localStorage : undefined
    this.contextManager = new ContextManager(storage)
    this.contextManager.on(ClientEvents.CONTEXT_CHANGED, () =>
      this.emit(ClientEvents.CONTEXT_CHANGED),
    )

    this.clientHttp = new ClientHttp(this)

    this.channels.set(NO_CHANNEL, this)

    /**
     * The client should only ever be ready when the context is loaded,
     * scheduling the client socket construction for after the context
     * is first loaded does the trick as the init event is only emitted after
     * the ClientSocket is built.
     */
    this.loadContext()

    if (this.options.initialContext) {
      this.setContext(this.options.initialContext)
    }

    this.authenticated = !!this.context.token

    this.clientSocket = new ClientSocket(this, this.options.ws)

    // Configure logger level
    if (this.options.logLevel !== undefined) {
      this.logger.setLevel(this.options.logLevel)
    } else if (this.options.debug) {
      this.logger.setLevel(LogLevel.DEBUG)
    }

    this.on(ClientEvents.ERROR, error => {
      this.logger.connection(LogLevel.ERROR, 'Client error', { error })
    })

    if (Environment.isBrowser && Environment.isDevelopment) {
      // @ts-ignore
      window.TypeFerry = this
    }

    this.connect().catch(error => {
      this.logger.connection(LogLevel.ERROR, 'Connection failed', { error })
    })

    const { idlenessTimeout } = this.options
    this.idleTimer = idlenessTimeout
      ? new IdleTimer(this, idlenessTimeout)
      : null
    this.visibilityManager = new VisibilityManager(this, this.idleTimer)
  }

  get isConnecting() {
    return !!this.clientSocket?.connecting
  }

  /**
   * Forces a reconnection. Useful for testing or manual recovery.
   */
  reconnect(): void {
    this.visibilityManager.reconnect()
  }

  get isOffline() {
    return !this.clientSocket?.ready
  }

  get isOnline() {
    return !!this.clientSocket?.ready
  }

  get connected() {
    return this.clientSocket.ready
  }

  /**
   * Opens the WebSocket connection and waits for initialization.
   * Reconnection is handled entirely by ClientSocket's exponential
   * backoff — this method just waits for the first successful init.
   */
  async connect(): Promise<void> {
    this.clientSocket.connect()

    try {
      await this.waitFor(ClientEvents.INITIALIZED, 30000)
    } catch (error) {
      this.logger.connection(
        LogLevel.ERROR,
        'Initialization failed',
        {},
        error as Error,
      )
      this.emit(ClientEvents.INITIALIZATION_FAILED, { error })
    }
  }

  /** Delegates to ContextManager. */
  loadContext(): void {
    this.contextManager.loadContext()
  }

  /** Delegates to ContextManager. */
  setContext(context: Record<string, unknown>): void {
    this.contextManager.setContext(context)
  }

  /**
   * Sets context (if changed) and reconnects the socket to re-authenticate.
   * Stops the current socket without triggering auto-reconnection, then
   * opens a fresh connection with the new context (token in query params).
   */
  async setContextAndReInit(context: Record<string, unknown>): Promise<void> {
    if (!isEqual(this.context, context)) {
      this.setContext(context)
    }

    this.clientSocket.retireConnection()

    this.logger.auth(LogLevel.DEBUG, 'setContextAndReInit: connecting')
    this.clientSocket.connect()
    this.logger.auth(
      LogLevel.DEBUG,
      'setContextAndReInit: waiting for INITIALIZED',
    )
    await this.waitFor(ClientEvents.INITIALIZED, 10000)
    this.logger.auth(LogLevel.DEBUG, 'setContextAndReInit: done')
  }

  /** Delegates to ContextManager. */
  updateContext(context: Record<string, unknown>): void {
    this.contextManager.updateContext(context)
  }

  /** Delegates to ContextManager. */
  clearContext(): void {
    this.contextManager.clearContext()
  }

  async close() {
    for (const request of this.requests) request.cancel()

    this.emit(ClientEvents.CLOSE)

    this.timeouts.forEach(timeout => clearTimeout(timeout))

    this.idleTimer?.destroy()
    this.visibilityManager.destroy()

    // Clear event sub/unsub timeouts.
    this.channels.forEach(channel => {
      channel.emit(TypeFerryEvents.COMMIT_PENDING_SUBSCRIPTIONS, {})
    })

    this.channels.forEach(channel => {
      channel.emit(TypeFerryEvents.COMMIT_PENDING_UNSUBSCRIPTIONS, {})
    })

    await this.clientSocket.close()
  }

  /**
   * Initializes the client. It should be called before any other method.
   *
   * It should be called whenever a transport is connected, either on reconnection or from calling `connect`.
   * Auth now happens during connection handshake. The authenticated state is set by AUTH_RESULT message.
   */
  async initialize() {
    if (this.initializing) {
      await this.waitFor(ClientEvents.INITIALIZED)
      return
    }

    this.initializing = true
    this.initialized = false
    this.loadContext()
    this.emit(ClientEvents.INITIALIZING)

    this.initialized = true
    this.initializing = false

    await this.resubscribeAllChannels()
    this.emit(ClientEvents.INITIALIZED, this.authenticated)

    return true
  }

  /**
   * The login method is always called via http so a http-only cookie can be set if the user so prefers.
   */
  async login(params: WebSocketRequestParams, opts?: CallOptions) {
    const response = await this.call(Methods.RPC_LOGIN, params, {
      ...opts,
      http: true,
    })

    if (!response || isEmpty(response)) {
      throw new Error(Errors.AUTHENTICATION_FAILED)
    }

    if (isPlainObject(response)) {
      await this.setContextAndReInit(response)
    }
  }

  async logout() {
    await this.call(Methods.RPC_LOGOUT)
    this.authenticated = false
    this.clearContext()
    this.emit(ClientEvents.LOGOUT, false)
  }

  async resubscribeAllChannels() {
    for (const [, channel] of this.channels) {
      await channel.resubscribe()
    }
  }

  async disconnect() {
    return this.close()
  }

  /**
   * Calls a method without expecting a return value (fire-and-forget).
   */
  void<T = unknown>(
    method: string,
    params?: MethodParams<T>,
    options: CallOptions = {},
  ): Promise<void> {
    if (this.options.beforeDispatch || options.signal) {
      return this.admittedRequest<void>(method, params, this.normalizeCallOptions(options), 'void')
    }
    const { http, httpFallback = true } = options

    return new Promise((resolve, reject) => {
      const payload = { method, params }

      this.emit(ClientEvents.OUTBOUND_MESSAGE, payload)

      if (http || (!this.clientSocket.ready && httpFallback)) {
        const uuid = Presentation.uuid()
        const httpPayload = {
          type: PayloadType.METHOD,
          uuid,
          method,
          params,
          void: true,
        }
        return this.clientHttp.request(httpPayload, null, reject)
      }

      // Fire-and-forget: send without waiting for acknowledgment
      this.clientSocket.send('rpc:void', payload)

      resolve()
    })
  }

  private async waitForInitialization(timeout: number) {
    try {
      this.logger.connection(LogLevel.DEBUG, 'Waiting for initialization', {
        timeout,
      })
      await this.waitFor(ClientEvents.INITIALIZED, Math.floor(timeout / 2))
    } catch {
      throw new Error('TypeFerry: Client not initialized')
    }
  }

  /**
   * Executes a method call using WebSocket RPC or HTTP fallback.
   * Uses UUID-based request/response correlation.
   */
  private async executeCall<R>(
    method: string,
    params: unknown,
    http: boolean,
    httpFallback: boolean,
    timeout: number,
    lifetime?: RequestLifetime,
  ): Promise<R> {
    lifetime?.remaining()
    this.emit(ClientEvents.OUTBOUND_MESSAGE, { method, params })

    lifetime?.remaining()

    // HTTP path: used when http=true or socket not ready with fallback enabled
    if (http || (!this.clientSocket.ready && httpFallback)) {
      return new Promise((resolve, reject) => {
        const uuid = Presentation.uuid()
        const payload = { uuid, type: PayloadType.METHOD, method, params }
        this.clientHttp.request<R>(payload, resolve, reject, lifetime?.signal)
      })
    }

    // WebSocket path: use UUID-correlated RPC
    try {
      return await this.clientSocket.emitWithAck<R>(
        'rpc',
        { method, params },
        timeout,
      )
    } catch (error) {
      // Pass through errorHandler if configured
      if (this.errorHandler) {
        this.errorHandler(error)
      }
      throw error
    }
  }

  private static readonly DEFAULT_CALL_OPTIONS = {
    timeout: DEFAULT_REQUEST_TIMEOUT_MS,
    http: false,
    httpFallback: true,
    ignoreInit: false,
    maxRetries: 0,
    delayBetweenRetriesMs: 3000,
  }

  private normalizeCallOptions(options?: CallOptions) {
    return { ...Client.DEFAULT_CALL_OPTIONS, ...options }
  }

  private async retryCall<R>(
    method: string,
    params: unknown,
    opts: ReturnType<typeof this.normalizeCallOptions>,
    lifetime?: RequestLifetime,
  ): Promise<R> {
    let lastError: unknown

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
      let dispatched = false
      const execute = (): Promise<R> => {
        dispatched = true
        return this.executeCall<R>(
          method, params, opts.http, opts.httpFallback,
          lifetime?.remaining() ?? opts.timeout, lifetime,
        )
      }
      try {
        return lifetime
          ? await this.dispatchAdmitted(method, 'call', opts, lifetime, execute)
          : await execute()
      } catch (error) {
        if (!dispatched) throw error
        lifetime?.remaining()
        lastError = error
        if (attempt > 0) {
          this.logger.method(LogLevel.WARN, 'Method call retry failed', {
            method,
            attempt: attempt + 1,
            maxRetries: opts.maxRetries,
            error: (error as Error).message,
          })
        }
        if (attempt >= opts.maxRetries) throw lastError
        let timer: ReturnType<typeof setTimeout> | undefined
        const delay = new Promise<void>(resolve => {
          timer = setTimeout(resolve, opts.delayBetweenRetriesMs)
        })
        try {
          if (lifetime) await lifetime.wait(delay)
          else await delay
        } finally {
          clearTimeout(timer)
        }
      }
    }

    throw lastError ?? new Error('TypeFerry method call did not execute')
  }

  private async waitForAdmittedInitialization(lifetime: RequestLifetime): Promise<void> {
    if (this.initialized) return
    let initialized: (() => void) | undefined
    const ready = new Promise<void>(resolve => {
      initialized = resolve
      this.once(ClientEvents.INITIALIZED, initialized)
    })
    try {
      await lifetime.wait(ready)
    } finally {
      if (initialized) this.off(ClientEvents.INITIALIZED, initialized)
    }
  }

  private async dispatchAdmitted<R>(
    method: string,
    kind: DispatchRequest['kind'],
    opts: ReturnType<typeof this.normalizeCallOptions>,
    lifetime: RequestLifetime,
    dispatch: () => Promise<R>,
  ): Promise<R> {
    while (true) {
      lifetime.remaining()
      const context = this.context
      const admission = await lifetime.wait(this.options.beforeDispatch?.({
        client: this,
        method,
        kind,
        deadline: lifetime.deadline,
        signal: lifetime.signal,
      }))
      if (admission?.signal) lifetime.follow(admission.signal)
      if (!opts.ignoreInit) await this.waitForAdmittedInitialization(lifetime)
      lifetime.remaining()

      // Renewal can race an awaited hook or initialization. Recheck before
      // sending, retaining every admitted session's cancellation boundary.
      if (context !== this.context) continue
      return dispatch()
    }
  }

  private async admittedRequest<R>(
    method: string,
    params: unknown,
    opts: ReturnType<typeof this.normalizeCallOptions>,
    kind: DispatchRequest['kind'],
  ): Promise<R> {
    const lifetime = new RequestLifetime(opts.timeout, opts.signal)
    this.requests.add(lifetime)
    try {
      if (kind === 'call') {
        return await lifetime.wait(this.retryCall<R>(method, params, opts, lifetime))
      }

      await lifetime.wait(this.dispatchAdmitted(method, kind, opts, lifetime, async () => {
        this.emit(ClientEvents.OUTBOUND_MESSAGE, { method, params })
        lifetime.remaining()
        if (opts.http || (!this.clientSocket.ready && opts.httpFallback)) {
          await new Promise<void>((resolve, reject) => {
            const payload = {
              type: PayloadType.METHOD,
              uuid: Presentation.uuid(),
              method,
              params,
              void: true,
            }
            void this.clientHttp.request(payload, resolve, reject, lifetime.signal)
          })
        } else {
          this.clientSocket.send('rpc:void', { method, params })
        }
      }))
      return undefined as R
    } finally {
      lifetime.dispose()
      this.requests.delete(lifetime)
    }
  }

  async call<P = Record<string, unknown>, R = unknown>(
    method: string,
    params?: P,
    options?: CallOptions,
  ): Promise<R> {
    const opts = this.normalizeCallOptions(options)
    if (this.options.beforeDispatch || opts.signal) {
      return this.admittedRequest<R>(method, params, opts, 'call')
    }

    const shouldWaitForInit = !opts.ignoreInit && !this.initialized
    if (shouldWaitForInit) await this.waitForInitialization(opts.timeout)

    return this.retryCall<R>(method, params, opts)
  }

  typed<T extends ServerMethods>(types: T) {
    return this as any as Client<T>
  }

  combine<T extends Client>(methods: T) {
    return this as any as Client<InferClientMethods<T> & MethodsType>
  }

  /** Handles subscription events from the server. */
  handleEvent(payload: Presentation.Payload) {
    if (typeof payload.channel !== 'string' || typeof payload.event !== 'string') {
      throw new TypeError('Invalid event payload')
    }

    this.emit(ClientEvents.INBOUND_MESSAGE, payload)
    this.logger.channel(LogLevel.DEBUG, 'Event received', {
      channel: payload.channel,
      event: payload.event,
    })
    const channel = this.channel(payload.channel)

    if (!channel) throw new TypeError('Invalid event channel')

    return channel.emit(payload.event, payload.params)
  }

  /**
   * Generates a URL path from string parts. The last argument can be a query
   * string object definition.
   */
  href(...path: (string | Parameters<typeof qs.stringify>[0])[]) {
    let queryString = ''

    if (isPlainObject(path.at(-1))) {
      const params = path.pop()

      if (params !== undefined && typeof params !== 'string') {
        queryString = '?'.concat(qs.stringify(params))
      }
    }

    if (path.some(isPlainObject))
      throw new Error('Parameters are only allowed in the last argument.')

    return `${this.clientHttp.host}/${path
      .join('/')
      .replace(/^\/|\/{2,}/, '')}${queryString}`
  }

  channel(name: string | object = NO_CHANNEL) {
    if (
      name != null &&
      typeof name === 'object' &&
      name.constructor.name === 'ObjectId' &&
      typeof name.toString === 'function'
    ) {
      name = name.toString()
    }

    if (!name || typeof name !== 'string') return null
    if (name === NO_CHANNEL) return this

    const channelName = name as string

    const existing = this.channels.get(channelName)
    if (existing) return existing

    const channel = new ClientChannel(channelName)
    channel.setClient(this)

    this.channels.set(channelName, channel)

    return channel
  }

  isConnected() {
    return new Promise(resolve => {
      if (this.connected) return resolve(true)

      this.once(ClientEvents.INITIALIZED, () => resolve(true))
    })
  }

  fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const optionHeaders = new Headers(options.headers)
    const headers = Object.fromEntries(optionHeaders.entries())
    const token = this.context.token

    if (typeof token === 'string') headers[TOKEN_HEADER_KEY] = token

    return fetch(url, {
      ...options,
      credentials: 'include',
      headers,
    })
  }
}

export type InferClientMethods<T extends Client> = T['m']
