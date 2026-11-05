# frozen_string_literal: true

require "rack"
require_relative "../runtime"
require_relative "rack_security_policy"

module TypeFerry
  module Transports
    class RateLimit
      attr_reader :max, :window_ms

      def initialize(max = 120, window_ms = 60_000)
        @max = max
        @window_ms = window_ms
      end
    end

    class SlidingWindowLimiter
      def initialize(limit, clock: nil)
        @limit = limit
        @clock = clock || -> { Process.clock_gettime(Process::CLOCK_MONOTONIC, :millisecond) }
        @entries = Hash.new { |hash, key| hash[key] = [] }
        @lock = Mutex.new
      end

      def consume(key)
        now = @clock.call
        @lock.synchronize do
          entries = @entries[key]
          entries.shift while entries.first && now - entries.first >= @limit.window_ms
          return [false, 0, entries.first + @limit.window_ms - now] if entries.length >= @limit.max

          entries << now
          [true, @limit.max - entries.length, entries.first + @limit.window_ms - now]
        end
      end
    end

    class RackHTTP
      CONTENT_TYPE = "text/plain; charset=utf-8"

      def initialize(server, origins: nil, rate_limit: RateLimit.new(120, 60_000), allow_originless: false,
        max_body_bytes: RackSecurityPolicy::DEFAULT_MAX_BODY_BYTES, client_address_resolver: nil)
        @server = server
        @security = RackSecurityPolicy.new(origins:, allow_originless:, max_body_bytes:, client_address_resolver:)
        @rate_limit = rate_limit
        @limiter = rate_limit && SlidingWindowLimiter.new(rate_limit)
      end

      def call(environment)
        request = Rack::Request.new(environment)
        return response(404, "") unless request.path == Protocol::HTTP_PATH
        return response(405, "") unless request.post?
        return response(403, "") unless @security.origin_allowed?(request.get_header("HTTP_ORIGIN"))

        client_address = @security.client_address(request)
        allowed, remaining, reset = @limiter ? @limiter.consume(client_address) : [true, 0, 0]
        return response(429, "", rate_headers(remaining, reset)) unless allowed

        status, headers, body = dispatch(request, client_address)
        rate_headers(remaining, reset).each { |name, value| headers[name] = value }
        [status, headers, body]
      end

      private

      def dispatch(request, client_address)
        transport = decode(@security.read_body(request))
        return error(Protocol::Errors::INVALID_REQUEST) unless transport.is_a?(Hash) && transport["payload"]

        payload = transport.fetch("payload")
        method_name = payload["method"]
        is_void = !!payload["void"]
        unless method_name.is_a?(String) && @server.methods.key?(method_name)
          return error(Protocol::Errors::METHOD_NOT_FOUND, method: method_name, void: is_void)
        end
        method = @server.methods.fetch(method_name)

        node = build_node(request, transport["context"], client_address)
        return error(Protocol::Errors::METHOD_FORBIDDEN, method: method_name, void: is_void) if method.protected? && !node.authenticated

        result = method.call(node, payload["params"])
        body = {"type" => "result", "method" => method_name, "result" => result}
        body["uuid"] = payload["uuid"] if payload["uuid"].is_a?(String)
        response(200, EJSON.stringify(body), node.response_headers)
      rescue SchemaValidationError => exception
        error(exception.message, uuid: payload&.dig("uuid"), errors: exception.errors, void: is_void)
      rescue PublicError => exception
        error(exception.message, uuid: payload&.dig("uuid"), void: is_void)
      rescue RequestBodyTooLarge
        response(413, "")
      rescue => exception
        warn("TypeFerry HTTP dispatch failed: #{exception.class}: #{exception.message}")
        error(Protocol::Errors::INTERNAL_ERROR, uuid: payload&.dig("uuid"), void: is_void)
      end

      def decode(body)
        EJSON.parse(body)
      rescue JSON::ParserError, TypeError, ArgumentError
        nil
      end

      def build_node(request, context, client_address)
        uuid = request.get_header("HTTP_X_CLIENT_ID")
        node = ClientNode.new(
          uuid: uuid.to_s.empty? ? SecureRandom.uuid : uuid,
          context:,
          headers: request_headers(request.env),
          remote_address: client_address,
          user_agent: request.user_agent.to_s
        )
        node.server = @server
        token = request.get_header("HTTP_X_API_KEY")
        # @type var empty_context: Hash[String, untyped]
        empty_context = {}
        auth_context = context.is_a?(Hash) ? context.dup : empty_context
        auth_context["token"] = token.delete_prefix("Bearer ") if token && token != "undefined"
        @server.authenticate(node, auth_context)
        node
      end

      def request_headers(environment)
        # @type var headers: Hash[String, String]
        headers = {}
        environment.each do |name, value|
          header = if name.start_with?("HTTP_")
            name.delete_prefix("HTTP_").downcase.tr("_", "-")
          elsif name == "CONTENT_TYPE" || name == "CONTENT_LENGTH"
            name.downcase.tr("_", "-")
          end
          headers[header] = value.to_s if header
        end
        headers
      end

      def error(message, uuid: nil, method: nil, errors: nil, void: false)
        return response(200, "") if void

        # @type var body: Hash[String, untyped]
        body = {"type" => "error", "message" => message}
        body["uuid"] = uuid if uuid.is_a?(String)
        body["method"] = method if method.is_a?(String) && !method.empty?
        body["errors"] = errors if errors
        response(200, EJSON.stringify(body))
      end

      def response(status, body, headers = [])
        values = {"content-type" => CONTENT_TYPE, "content-length" => body.bytesize.to_s}
        headers.each { |name, value| values[name] = value }
        [status, values, [body]]
      end

      def rate_headers(remaining, reset_ms)
        return [] unless @rate_limit

        [
          ["ratelimit-limit", @rate_limit.max.to_s],
          ["ratelimit-remaining", [0, remaining].max.to_s],
          ["ratelimit-reset", (([0, reset_ms].max + 999) / 1000).to_s]
        ]
      end
    end
  end
end
