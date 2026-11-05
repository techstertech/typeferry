# frozen_string_literal: true

module TypeFerry
  module Transports
    class RequestBodyTooLarge < StandardError
    end

    # Shared fail-closed browser and request boundary for Rack transports.
    class RackSecurityPolicy
      DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024

      def initialize(origins: nil, allow_originless: false, max_body_bytes: DEFAULT_MAX_BODY_BYTES,
        client_address_resolver: nil)
        raise ArgumentError, "maximum body bytes must be positive" unless max_body_bytes.positive?

        @origins = origins&.to_set&.freeze
        @allow_originless = !!allow_originless
        @max_body_bytes = Integer(max_body_bytes)
        @client_address_resolver = client_address_resolver
      end

      def origin_allowed?(origin)
        return true unless @origins
        return @allow_originless if origin.nil?

        !origin.empty? && @origins.include?(origin)
      end

      def read_body(request)
        declared = request.content_length && Integer(request.content_length, 10)
        raise RequestBodyTooLarge if declared && declared > @max_body_bytes

        body = request.body.read(@max_body_bytes + 1)
        raise RequestBodyTooLarge if body.bytesize > @max_body_bytes

        body
      end

      def client_address(request)
        value = @client_address_resolver ? @client_address_resolver.call(request.env) : request.ip
        value.to_s
      end
    end
  end
end
