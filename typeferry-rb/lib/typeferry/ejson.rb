# frozen_string_literal: true

require "base64"
require "json"
require "time"

module TypeFerry
  module EJSON
    DateValue = Struct.new(:milliseconds)
    RegexpValue = Struct.new(:source, :flags)
    BinaryValue = Struct.new(:bytes)
    CustomValue = Struct.new(:type_name, :value)

    VALID_REGEXP_FLAGS = "gimuy"
    MAX_ARRAY_INDEX = (2**32) - 2
    TAG_KEYS = [
      ["$date"],
      ["$regexp", "$flags"],
      ["$InfNaN"],
      ["$binary"],
      ["$escape"],
      ["$type", "$value"]
    ].freeze

    # @type var @custom_factories: Hash[String, Proc]
    @custom_factories = {}

    class << self
      def add_type(name, &factory)
        raise ArgumentError, "a custom type factory is required" unless factory

        @custom_factories[name] = factory
      end

      def clear_types
        @custom_factories.clear
      end

      def parse(source)
        raise TypeError, "EJSON.parse argument should be a string" unless source.is_a?(String)

        from_json_value(JSON.parse(source))
      end

      def stringify(value, canonical: false, indent: nil)
        json_value = to_json_value(value)
        json_value = order_properties(json_value, canonical:)

        state = JSON::State.new(
          indent: (indent == true) ? "  " : indent.to_s,
          space: indent ? " " : "",
          object_nl: indent ? "\n" : "",
          array_nl: indent ? "\n" : "",
          max_nesting: false,
          allow_nan: false
        )
        JSON.generate(json_value, state)
      end

      def to_json_value(value)
        converted = convert_object(value)
        return converted unless converted.equal?(value)

        case value
        when Hash
          return {"$escape" => value.transform_values { |item| to_json_value(item) }} if tag_shape?(value)

          value.to_h { |key, item| [String(key), to_json_value(item)] }
        when Array
          value.map { |item| to_json_value(item) }
        else
          value
        end
      end

      def from_json_value(value)
        if value.is_a?(Hash) && value.length <= 2 && value.keys.all? { |key| key.start_with?("$") }
          converted = convert_json(value)
          return converted unless converted.equal?(value)
        end

        case value
        when Hash
          value.transform_values { |item| from_json_value(item) }
        when Array
          value.map { |item| from_json_value(item) }
        else
          value
        end
      end

      private

      def convert_object(value)
        case value
        when DateValue
          {"$date" => value.milliseconds}
        when Time
          {"$date" => (value.to_r * 1000).round}
        when RegexpValue
          {"$regexp" => value.source, "$flags" => value.flags}
        when Regexp
          {"$regexp" => value.source, "$flags" => regexp_flags(value)}
        when BinaryValue
          {"$binary" => Base64.strict_encode64(value.bytes)}
        when CustomValue
          {"$type" => value.type_name, "$value" => to_json_value(value.value)}
        when Float
          inf_nan(value)
        else
          if value.respond_to?(:type_name) && value.respond_to?(:to_json_value)
            return {"$type" => value.type_name, "$value" => to_json_value(value.to_json_value)}
          end

          value
        end
      end

      def convert_json(value)
        if exact_keys?(value, "$date")
          DateValue.new(milliseconds: Integer(value.fetch("$date")))
        elsif exact_keys?(value, "$regexp", "$flags")
          RegexpValue.new(
            source: String(value.fetch("$regexp")),
            flags: sanitize_flags(value.fetch("$flags"))
          )
        elsif exact_keys?(value, "$InfNaN")
          decode_inf_nan(value.fetch("$InfNaN"))
        elsif exact_keys?(value, "$binary")
          BinaryValue.new(bytes: decode_base64(value.fetch("$binary")))
        elsif exact_keys?(value, "$escape")
          inner = value.fetch("$escape")
          raise TypeError, "$escape value must be an object" unless inner.is_a?(Hash)

          inner.transform_values { |item| from_json_value(item) }
        elsif exact_keys?(value, "$type", "$value")
          name = String(value.fetch("$type"))
          factory = @custom_factories[name]
          raise ArgumentError, "Custom EJSON type #{name} is not defined" unless factory

          factory.call(from_json_value(value.fetch("$value")))
        else
          value
        end
      end

      def exact_keys?(value, *keys)
        value.length == keys.length && keys.all? { |key| value.key?(key) }
      end

      def tag_shape?(value)
        keys = value.keys.map(&:to_s)
        TAG_KEYS.any? { |tag_keys| keys == tag_keys }
      end

      def regexp_flags(value)
        flags = +""
        flags << "i" if value.casefold?
        flags << "m" if (value.options & Regexp::MULTILINE) != 0
        flags
      end

      def sanitize_flags(value)
        # @type var seen: Hash[String, bool]
        seen = {}
        String(value).slice(0, 50).to_s.each_char.with_object(+"") do |character, flags|
          next unless VALID_REGEXP_FLAGS.include?(character)
          next if seen[character]

          seen[character] = true
          flags << character
        end
      end

      def inf_nan(value)
        return value if value.finite?

        sign = if value.nan?
          0
        elsif value.positive?
          1
        else
          -1
        end
        {"$InfNaN" => sign}
      end

      def decode_inf_nan(sign)
        case sign
        when 0 then Float::NAN
        when 1 then Float::INFINITY
        else -Float::INFINITY
        end
      end

      def decode_base64(value)
        source = String(value)
        raise ArgumentError, "invalid base64 length" unless (source.length % 4).zero?

        Base64.strict_decode64(source.tr("-_", "+/"))
      end

      # JSON.stringify enumerates index keys first even in canonical mode.
      # Other canonical keys compare by UTF-16 units, not Unicode codepoints.
      def order_properties(value, canonical: false)
        case value
        when Hash
          indices, remaining = value.keys.partition { |key| array_index_key?(key) }
          indices.sort_by!(&:to_i)
          remaining.sort_by! { |key| key.encode(Encoding::UTF_16BE).bytes } if canonical

          (indices + remaining).to_h { |key| [key, order_properties(value.fetch(key), canonical:)] }
        when Array
          value.map { |item| order_properties(item, canonical:) }
        else
          value
        end
      end

      def array_index_key?(key)
        key.length <= 10 && /\A(?:0|[1-9][0-9]*)\z/.match?(key) && key.to_i <= MAX_ARRAY_INDEX
      end
    end
  end
end
