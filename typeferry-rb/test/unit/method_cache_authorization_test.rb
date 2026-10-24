# frozen_string_literal: true

require_relative "../test_helper"

class MethodCacheAuthorizationTest < Minitest::Test
  def test_authenticated_cached_calls_keep_caller_results_separate
    [false, true].each do |protected|
      callers = Array.new(2) do
        node = TypeFerry::ClientNode.new(context: {"user" => {"_id" => SecureRandom.uuid}})
        node.authenticated = true
        node
      end
      method = TypeFerry::Method.new("private", ->(node, _params) { node.user_id }, cache: true, protected:)
      params = {"resource" => SecureRandom.uuid}

      callers.each do |caller|
        assert_equal caller.user_id, method.call(caller, params)
      end
    end
  end

  def test_authenticated_cached_calls_recheck_inline_authorization
    caller = TypeFerry::ClientNode.new
    caller.authenticated = true
    allowed = true
    handler = lambda do |_node, _params|
      raise TypeFerry::PublicError, "Access denied" unless allowed

      "private result"
    end
    method = TypeFerry::Method.new("permission", handler, cache: true)
    params = {"resource" => SecureRandom.uuid}

    assert_equal "private result", method.call(caller, params)

    allowed = false

    error = assert_raises(TypeFerry::PublicError) { method.call(caller, params) }
    assert_equal "Access denied", error.message
  end

  def test_cache_reads_and_writes_follow_connection_authentication_changes
    caller = TypeFerry::ClientNode.new
    calls = 0
    handler = ->(_node, _params) { calls += 1 }
    method = TypeFerry::Method.new("transition", handler, cache: true)
    fresh_params = {"fresh" => true}

    assert_equal 1, method.call(caller, {})
    assert_equal 1, method.call(caller, {})

    caller.authenticated = true

    assert_equal 2, method.call(caller, {})
    assert_equal 3, method.call(caller, fresh_params)

    caller.authenticated = false

    assert_equal 4, method.call(caller, fresh_params)
    assert_equal 4, method.call(caller, fresh_params)
    assert_equal 1, method.call(caller, {})

    caller.authenticated = true

    assert_equal 5, method.call(caller, {})
  end

  def test_anonymous_cache_keeps_its_ttl
    caller = TypeFerry::ClientNode.new
    now = 0
    calls = 0
    method = TypeFerry::Method.new("anonymous", ->(*) { calls += 1 }, cache: true,
      max_age_ms: 10, clock: -> { now })

    assert_equal 1, method.call(caller, {})
    assert_equal 1, method.call(caller, {})

    now = 10

    assert_equal 2, method.call(caller, {})
  end
end
