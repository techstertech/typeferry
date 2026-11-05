# frozen_string_literal: true

require "json"
require_relative "../test_helper"

class EJSONFixturesTest < Minitest::Test
  Address = Data.define(:value)

  def setup
    TypeFerry::EJSON.clear_types
  end

  def teardown
    TypeFerry::EJSON.clear_types
  end

  Dir[File.join(TypeFerryTest::FIXTURES, "ejson", "*.case.json")].sort.each do |path|
    define_method("test_#{File.basename(path, ".case.json").tr("-", "_")}") do
      fixture = JSON.parse(File.read(path))
      register_types(fixture)
      value = rehydrate(fixture.fetch("value"))
      canonical = fixture.fetch("canonical", false)

      assert_equal fixture.fetch("encoded"), TypeFerry::EJSON.stringify(value, canonical:)
      assert_equal fixture.fetch("encoded"), TypeFerry::EJSON.stringify(TypeFerry::EJSON.parse(fixture.fetch("encoded")), canonical:)
    end
  end

  private

  def register_types(fixture)
    fixture.dig("register", "custom_types")&.each do |name|
      TypeFerry::EJSON.add_type(name) { |value| Address.new(value:) }
    end
  end

  def rehydrate(value)
    case value.fetch("__kind")
    when "null" then nil
    when "bool", "int", "float", "string" then value.fetch("value")
    when "array" then value.fetch("items").map { |item| rehydrate(item) }
    when "object" then value.fetch("entries").to_h { |key, item| [key, rehydrate(item)] }
    when "date" then TypeFerry::EJSON::DateValue.new(milliseconds: value.fetch("millis"))
    when "binary" then TypeFerry::EJSON::BinaryValue.new(bytes: Base64.strict_decode64(value.fetch("base64")))
    when "regex" then TypeFerry::EJSON::RegexpValue.new(source: value.fetch("source"), flags: value.fetch("flags"))
    when "inf_nan" then {0 => Float::NAN, 1 => Float::INFINITY, -1 => -Float::INFINITY}.fetch(value.fetch("sign"))
    when "custom" then Address.new(value: rehydrate(value.fetch("inner")))
    else raise "unknown fixture kind: #{value.fetch("__kind")}"
    end
  end
end

class EJSONFixturesTest::Address
  def type_name
    "address"
  end

  def to_json_value
    value
  end
end
