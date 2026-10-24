# frozen_string_literal: true

require "monitor"
require "securerandom"

module TypeFerry
  class PublicError < StandardError
  end

  class SchemaValidationError < PublicError
    attr_reader :errors

    def initialize(errors)
      @errors = errors.freeze
      super("Invalid Params: #{errors.join(", ")}")
    end
  end

  class ValidationIssue
    attr_reader :path, :message

    def initialize(path, message)
      @path = path
      @message = message
    end

    def format
      "#{path.join(".")}: #{message}"
    end
  end

  class ValidationResult
    attr_reader :success, :data, :issues

    def initialize(success, data, issues)
      @success = success
      @data = data
      @issues = issues
    end
  end

  module Context
    KEY = :__typeferry_execution_context

    class << self
      def current
        Thread.current[KEY]
      end

      def with(value)
        previous = Thread.current[KEY]
        Thread.current[KEY] = value
        yield
      ensure
        Thread.current[KEY] = previous
      end
    end
  end

  class ClientNode
    attr_reader :socket, :uuid, :context, :user_id, :response_headers, :headers, :remote_address, :user_agent
    attr_accessor :authenticated, :server, :meta

    def initialize(socket: nil, uuid: SecureRandom.uuid, context: nil, headers: {}, remote_address: "", user_agent: "")
      @socket = socket
      @uuid = uuid
      @authenticated = false
      @meta = {}
      @response_headers = []
      @headers = headers.to_h do |name, value|
        [name.to_s.downcase.freeze, value.to_s.freeze]
      end.freeze
      @remote_address = remote_address.to_s.freeze
      @user_agent = user_agent.to_s.freeze
      set_context(context)
    end

    def set_context(context)
      @context = context
      user = context.is_a?(Hash) ? context["user"] || context[:user] : nil
      @user_id = user.is_a?(Hash) ? (user["_id"] || user[:_id])&.to_s : nil
    end

    def emit_event(event, channel, params)
      socket&.send_text(EJSON.stringify({"t" => Protocol::MessageType::EVENT, "uuid" => SecureRandom.uuid,
        "event" => event, "channel" => channel, "params" => params}))
    end

    def emit_auth_result(value)
      socket&.send_text(EJSON.stringify({"t" => Protocol::MessageType::AUTH, "authenticated" => value}))
    end

    def close
      socket&.close
    end
  end

  class Method
    attr_reader :name

    def initialize(name, handler, protected: false, cache: false,
      max_age_ms: Protocol::DEFAULT_CACHE_MAX_AGE_MS, schema: nil, middleware: [], clock: nil)
      @name = name
      @handler = handler
      @protected = protected
      @cache = cache
      @max_age_ms = max_age_ms
      @schema = schema
      @middleware = middleware.freeze
      @clock = clock || -> { Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond) }
      @entries = {}
      @lock = Mutex.new
    end

    def protected?
      @protected
    end

    def call(node, params)
      validate(params)
      # Authenticated calls must run handler-owned permission checks every time.
      # Anonymous cached results must not depend on caller context.
      key = EJSON.stringify(params) if @cache && !node&.authenticated
      hit = cached_value(key) if key
      return hit.fetch(:value) if hit

      execution_id = SecureRandom.uuid
      started_at = @clock.call
      result = Context.with({execution_id:, context: node&.context}) do
        transformed = @middleware.reduce(params) { |value, step| step.call(node, value) }
        @handler.call(node, transformed)
      end
      store(key, result) if key
      result
    ensure
      if defined?(started_at) && started_at
        node&.server&.emit_server_event(:method_execution, {
          method: name, time: @clock.call - started_at, params:, result:
        })
      end
    end

    private

    def validate(params)
      return unless @schema

      # @type var empty_params: Hash[String, untyped]
      empty_params = {}
      result = @schema.safe_parse(params.nil? ? empty_params : params)
      return if result.success

      raise SchemaValidationError, result.issues.map(&:format)
    end

    def cached_value(key)
      return unless @cache

      @lock.synchronize do
        entry = @entries[key]
        entry if entry && (@clock.call - entry.fetch(:timestamp) < @max_age_ms)
      end
    end

    def store(key, value)
      return unless @cache

      @lock.synchronize { @entries[key] = {timestamp: @clock.call, value:} }
    end
  end

  class RoomRegistry
    def initialize
      @rooms = Hash.new { |hash, key| hash[key] = Set.new }
      @socket_rooms = Hash.new { |hash, key| hash[key] = Set.new }
      @lock = Monitor.new
    end

    def join(socket, room)
      @lock.synchronize do
        @rooms[room] << socket
        @socket_rooms[socket] << room
      end
    end

    def leave(socket, room)
      @lock.synchronize do
        @rooms[room].delete(socket)
        @rooms.delete(room) if @rooms[room].empty?
        @socket_rooms[socket].delete(room)
        @socket_rooms.delete(socket) if @socket_rooms[socket].empty?
      end
    end

    def leave_all(socket)
      @lock.synchronize { @socket_rooms[socket].to_a }.each { |room| leave(socket, room) }
    end

    def broadcast(room, payload, exclude_uuid: nil)
      sockets = @lock.synchronize { @rooms[room].to_a }
      sockets.reject { |socket| socket.uuid == exclude_uuid }.each { |socket| socket.send_text(payload) }
    end

    def include?(socket, room)
      @lock.synchronize { @rooms[room].include?(socket) }
    end

    def size(room)
      @lock.synchronize { @rooms[room].size }
    end
  end

  class Event
    attr_reader :name

    def initialize(name, server:, protected: false, user: false, cluster: false,
      exclude_originator: false, should_subscribe: nil)
      @name = name
      @server = server
      @protected = protected || user
      @user = user
      @cluster = cluster
      @exclude_originator = exclude_originator
      @should_subscribe = should_subscribe
    end

    def subscribable?(node, channel)
      return false if @protected && !node.authenticated
      return false if @user && channel != node.user_id

      @should_subscribe ? @should_subscribe.call(node, name, channel) : true
    end

    def emit(channel, params = nil)
      frame = EJSON.stringify({"t" => Protocol::MessageType::EVENT, "uuid" => SecureRandom.uuid,
        "event" => name, "channel" => channel, "params" => params})
      excluded = (@exclude_originator && params.is_a?(Hash)) ? params["uuid"] : nil
      @server.propagate(name, channel, frame, exclude_uuid: excluded, cluster: @cluster)
    end
  end

  class Server
    attr_reader :rooms, :methods, :events, :uuid, :redis_transport

    def initialize(**options)
      @options = options.freeze
      @uuid = options.fetch(:uuid, SecureRandom.uuid)
      @redis_transport = options[:redis]
      @methods = {}
      @events = {}
      @clients = {}
      @listeners = Hash.new { |hash, key| hash[key] = [] }
      @rooms = RoomRegistry.new
      @lock = Monitor.new
      @auth = nil
      @channel_authorizer = ->(_node, _channel) { true }
      install_default_methods
    end

    def add_method(name, handler = nil, **options, &block)
      callable = handler || block
      raise ArgumentError, "method handler is required" unless callable

      @lock.synchronize { @methods[name] = Method.new(name, callable, **options) }
    end

    def add_event(name, **options)
      @lock.synchronize { @events[name] = Event.new(name, server: self, **options) }
    end

    def register(target)
      target.class.typeferry_methods.each do |definition|
        options = definition.fetch(:options)
        handler = target.method(definition.fetch(:ruby_name))
        add_method(definition.fetch(:wire_name), handler, **options)
      end
    end

    def call(name, params = nil, node: nil)
      node ||= ClientNode.new
      method = @lock.synchronize { @methods[name] }
      raise PublicError, Protocol::Errors::METHOD_NOT_FOUND unless method
      raise PublicError, Protocol::Errors::METHOD_FORBIDDEN if method.protected? && !node.authenticated

      method.call(node, params)
    end

    def set_auth(auth:, log_in:)
      @auth = auth
      add_method(Protocol::Methods::RPC_LOGIN, log_in)
    end

    def authenticate(node, context)
      result = @auth&.call(node, context)
      node.authenticated = !!result
      node.set_context(result || nil)
      result
    end

    def attach_redis(transport)
      @lock.synchronize { @redis_transport = transport }
      transport
    end

    def set_channel_authorization(callable)
      @channel_authorizer = callable
    end

    def add_client(node)
      node.server = self
      previous = @lock.synchronize do
        displaced = @clients[node.uuid]
        @clients[node.uuid] = node
        displaced
      end
      @redis_transport&.register_client(node)
      previous&.close unless previous.equal?(node)
      node
    end

    def delete_client(node)
      rooms.leave_all(node.socket) if node.socket
      removed = @lock.synchronize do
        current = @clients[node.uuid]
        @clients.delete(node.uuid) if current.equal?(node)
      end
      @redis_transport&.remove_client(node) if removed
      !!removed
    end

    def clients_for_user(user_id)
      @lock.synchronize { @clients.values.select { |node| node.user_id == user_id }.freeze }
    end

    def client_snapshot
      @lock.synchronize { @clients.values.freeze }
    end

    def disconnect_user(user_id)
      clients_for_user(user_id).each(&:close)
    end

    def on_server_event(name, &listener)
      @lock.synchronize { @listeners[name] << listener }
    end

    def emit_server_event(name, payload)
      @lock.synchronize { @listeners[name].dup }.each { |listener| listener.call(payload) }
    end

    def propagate(event, channel, payload, exclude_uuid: nil, cluster: false)
      transport = @redis_transport
      if cluster && transport
        transport.publish(event:, channel:, message: payload, exclude_uuid:)
      else
        rooms.broadcast(room_name(channel, event), payload, exclude_uuid:)
      end
    end

    def close
      @lock.synchronize { @clients.values }.each(&:close)
      @redis_transport&.close
      true
    end

    private

    def install_default_methods
      add_method(Protocol::Methods::RPC_ON) do |node, params|
        raise Protocol::Errors::INVALID_REQUEST unless node

        subscription_result(node, params, subscribe: true)
      end
      add_method(Protocol::Methods::RPC_OFF) do |node, params|
        raise Protocol::Errors::INVALID_REQUEST unless node

        subscription_result(node, params, subscribe: false)
      end
      add_method(Protocol::Methods::RPC_LOGOUT, protected: true) do |node, _params|
        raise Protocol::Errors::INVALID_REQUEST unless node

        node.authenticated = false
        node.set_context(nil)
        @redis_transport&.register_client(node)
        emit_server_event(:logout, node)
        true
      end
    end

    def subscription_result(node, params, subscribe:)
      # @type var default_params: Hash[String, untyped]
      default_params = {}
      params ||= default_params
      channel = params["channel"] || Protocol::NO_CHANNEL
      names = params["events"] || []
      allowed_channel = @channel_authorizer.call(node, channel)

      names.to_h do |name|
        event = @lock.synchronize { @events[name] }
        allowed = !!(allowed_channel && event && event.subscribable?(node, channel) && node.socket)
        room = room_name(channel, name)
        if node.socket && (allowed || !subscribe)
          subscribe ? rooms.join(node.socket, room) : rooms.leave(node.socket, room)
        end
        [name, subscribe ? allowed : !!event]
      end
    end

    def room_name(channel, event)
      "typeferry:#{channel}:#{event}"
    end
  end
end
