# frozen_string_literal: true

require_relative "../test_helper"

class EJSONTest < Minitest::Test
  def test_rejects_non_string_parse_input
    assert_raises(TypeError) { TypeFerry::EJSON.parse({}) }
  end

  def test_rejects_invalid_base64_length
    assert_raises(ArgumentError) { TypeFerry::EJSON.parse('{"$binary":"AAA"}') }
  end

  def test_accepts_url_safe_base64
    value = TypeFerry::EJSON.parse('{"$binary":"-_8="}')

    assert_equal "\xfb\xff".b, value.bytes
  end

  def test_sanitizes_regexp_flags
    value = TypeFerry::EJSON.parse('{"$regexp":"x","$flags":"ggiuzzzy"}')

    assert_equal "giuy", value.flags
  end

  def test_decoy_with_extra_key_remains_plain
    value = TypeFerry::EJSON.parse('{"$date":0,"extra":true}')

    assert_equal({"$date" => 0, "extra" => true}, value)
  end

  def test_canonical_stringify_sorts_nested_objects
    value = {"z" => {"b" => 1, "a" => 2}, "a" => 3}

    assert_equal '{"a":3,"z":{"a":2,"b":1}}', TypeFerry::EJSON.stringify(value, canonical: true)
  end

  def test_javascript_index_keys_precede_other_keys_recursively
    value = {"z" => {"10" => 10, "2" => 2, "01" => 1}, "10" => 10, "2" => 2, "a" => 0}

    assert_equal '{"2":2,"10":10,"z":{"2":2,"10":10,"01":1},"a":0}', TypeFerry::EJSON.stringify(value)
  end

  def test_canonical_keys_use_index_order_then_utf16_order
    value = {"\ue000" => 1, "\u{10000}" => 2, "10" => {"2" => 3, "1" => 4}, "2" => 5}

    assert_equal '{"2":5,"10":{"1":4,"2":3},"𐀀":2,"":1}', TypeFerry::EJSON.stringify(value, canonical: true)
  end
end
