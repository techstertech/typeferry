# frozen_string_literal: true

require "typeferry/transports/websocket"
require_relative "../test_helper"

class WebSocketTest < Minitest::Test
  Socket = Struct.new(:uuid, :sent, :close_codes, :pongs) do
    def send_text(value) = sent << TypeFerry::EJSON.parse(value)
    def close(code = 1000) = close_codes << code
    def pong! = self.pongs += 1
  end

  def test_ping_is_answered_and_pong_updates_liveness
    socket = Socket.new("one", [], [], 0)
    dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(TypeFerry::Server.new, socket)

    dispatcher.receive(TypeFerry::EJSON.stringify({"t" => TypeFerry::Protocol::MessageType::PING}))
    dispatcher.receive(TypeFerry::EJSON.stringify({"t" => TypeFerry::Protocol::MessageType::PONG}))

    assert_equal [{"t" => TypeFerry::Protocol::MessageType::PONG}], socket.sent
    assert_equal 1, socket.pongs
  end

  def test_close_removes_client_and_rooms_once
    server = TypeFerry::Server.new
    socket = Socket.new("one", [], [], 0)
    dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(server, socket)
    server.add_event("changed")
    dispatcher.open
    server.call("rpc:on", {"events" => ["changed"], "channel" => "records"}, node: dispatcher.node)

    dispatcher.close
    dispatcher.close

    refute server.rooms.include?(socket, "typeferry:records:changed")
  end

  def test_handshake_authentication_is_bounded_and_fails_closed
    socket = Socket.new("one", [], [], 0)
    dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(
      TypeFerry::Server.new,
      socket,
      handshake_authenticator: ->(*) do
        sleep 1
        {"user" => {"_id" => "late"}}
      end,
      auth_timeout_ms: 10
    )

    started_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    dispatcher.open

    assert_operator Process.clock_gettime(Process::CLOCK_MONOTONIC) - started_at, :<, 0.5
    assert_equal [{"t" => "auth", "authenticated" => false}], socket.sent
    refute dispatcher.node.authenticated
  end

  def test_meta_is_parsed_and_invalid_shapes_are_normalized
    socket = Socket.new("one", [], [], 0)
    valid = TypeFerry::Transports::WebSocketDispatcher.new(TypeFerry::Server.new, socket,
      query: {"meta" => JSON.generate({"editor" => "ruby"})})
    invalid = TypeFerry::Transports::WebSocketDispatcher.new(TypeFerry::Server.new, socket,
      query: {"meta" => JSON.generate(["not", "an", "object"])})
    oversized = TypeFerry::Transports::WebSocketDispatcher.new(TypeFerry::Server.new, socket,
      query: {"meta" => JSON.generate({"value" => "x" * 10_000})})

    assert_equal({"editor" => "ruby"}, valid.node.meta)
    assert_equal({}, invalid.node.meta)
    assert_equal({}, oversized.node.meta)
  end

  def test_handshake_authenticator_takes_precedence_over_query_token
    server = TypeFerry::Server.new
    server.set_auth(auth: ->(*) { raise "token auth must not run" }, log_in: ->(*) { true })
    socket = Socket.new("one", [], [], 0)
    dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(server, socket,
      query: {"token" => "secret"}, handshake_authenticator: ->(*) { false })

    dispatcher.open

    assert_equal [{"t" => "auth", "authenticated" => false}], socket.sent
  end

  def test_handshake_authentication_uses_javascript_truthiness
    [nil, false, 0, -0.0, Float::NAN, "", {}, []].each do |outcome|
      socket = Socket.new("peer", [], [], 0)
      dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(
        TypeFerry::Server.new, socket, handshake_authenticator: ->(*) { outcome }
      )

      dispatcher.open

      expected = outcome.is_a?(Hash) || outcome.is_a?(Array)
      assert_equal [{"t" => "auth", "authenticated" => expected}], socket.sent, outcome.inspect
    ensure
      dispatcher&.close
    end
  end

  def test_invalid_uuid_is_replaced_instead_of_sanitized
    socket = Socket.new("peer", [], [], 0)
    dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(
      TypeFerry::Server.new, socket, query: {"uuid" => "a$b"}
    )

    refute_equal "ab", dispatcher.node.uuid
    assert_match(/\A[a-zA-Z0-9-]{1,64}\z/, dispatcher.node.uuid)
  end

  def test_metadata_checks_raw_input_byte_size
    socket = Socket.new("peer", [], [], 0)
    raw = JSON.generate({"$date" => 123}) + " " * 10_000
    dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(
      TypeFerry::Server.new, socket, query: {"meta" => raw}
    )

    assert_empty dispatcher.node.meta
  end
end
