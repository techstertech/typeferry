# frozen_string_literal: true

require "json"
require "typeferry/transports/websocket"
require_relative "../test_helper"

class WebSocketFixturesTest < Minitest::Test
  Socket = Struct.new(:uuid, :sent, :closed) do
    def send_text(value) = sent << value
    def close = self.closed = true
  end

  Dir[File.join(TypeFerryTest::FIXTURES, "ws", "*.seq.ndjson")].sort.each do |path|
    define_method("test_#{File.basename(path, ".seq.ndjson").tr("-", "_")}") do
      operations = File.readlines(path, chomp: true).map { |line| JSON.parse(line) }
      setup = operations.shift
      server = build_server(setup)
      socket = Socket.new("socket", [], false)
      dispatcher = nil

      operations.each do |operation|
        case operation.fetch("op")
        when "connect"
          dispatcher = TypeFerry::Transports::WebSocketDispatcher.new(server, socket, query: operation.fetch("query"))
          socket.uuid = dispatcher.node.uuid
          dispatcher.open
        when "send"
          dispatcher.receive(TypeFerry::EJSON.stringify(operation.fetch("frame")))
        when "server_emit"
          server.events.fetch(operation.fetch("event")).emit(operation.fetch("channel"), operation.fetch("params"))
        when "expect_server_frame"
          actual = TypeFerry::EJSON.parse(socket.sent.shift)
          actual.delete("uuid") unless operation.fetch("frame").key?("uuid")
          assert_equal operation.fetch("frame"), actual
        when "expect_no_server_frame"
          assert_empty socket.sent
        when "disconnect"
          dispatcher.close
        end
      end
    end
  end

  private

  def build_server(setup)
    server = TypeFerry::Server.new
    setup.fetch("methods", []).each do |method|
      name = method.fetch("handler")
      handler = if name == "echo_params"
        ->(_node, params) { params }
      elsif name == "increment_counter"
        calls = 0
        ->(*) { calls += 1 }
      elsif name.start_with?("raise_public:")
        ->(*) { raise TypeFerry::PublicError, name.delete_prefix("raise_public:") }
      else
        ->(*) { name.delete_prefix("return_const:") }
      end
      server.add_method(method.fetch("name"), handler, protected: method.fetch("protected", false),
        cache: method.fetch("cache", false))
    end
    setup.fetch("events", []).each { |event| server.add_event(event.fetch("name")) }
    if setup["auth"]
      auth = setup.fetch("auth")
      server.set_auth(auth: ->(_node, context) {
        (context["token"] == auth.fetch("accept_token")) ? {"user" => auth.fetch("user")} : false
      }, log_in: ->(*) { true })
    end
    server
  end
end
