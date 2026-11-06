# frozen_string_literal: true

require "json"
require "rbconfig"
require "shellwords"
require "tempfile"
require "timeout"
require "tmpdir"
require "typeferry/process_supervisor"
require_relative "../test_helper"

class ProcessSupervisorTest < Minitest::Test
  def setup
    @supervisor = TypeFerry::ProcessSupervisor.new(poll_interval: 0.005, termination_grace: 0.05)
  end

  def teardown
    @supervisor.close
  end

  def test_successful_process_returns_its_exit_status
    job = @supervisor.start(id: "success", command: [RbConfig.ruby, "-e", "exit 0"])

    result = job.wait(timeout: 2)

    assert_equal :exited, result.status
    assert_equal 0, result.exit_status
    assert result.success?
    refute @supervisor.active?("success")
  end

  def test_singleton_command_uses_the_literal_executable_path
    with_literal_executable do |executable, _directory, receipt|
      job = @supervisor.start(id: "literal-path", command: [executable],
        environment: {"TYPEFERRY_TEST_RECEIPT" => receipt})

      assert job.wait(timeout: 2).success?
      assert_equal [], JSON.parse(File.read(receipt)).fetch("arguments")
    end
  end

  def test_singleton_command_cannot_run_shell_syntax
    Dir.mktmpdir("typeferry-shell-syntax") do |directory|
      marker = File.join(directory, "unexpected")
      shell_command = [RbConfig.ruby, "-e", "File.write(ARGV.fetch(0), 'shell')", marker].shelljoin

      job = @supervisor.start(id: "shell-syntax", command: [shell_command])
      result = job.wait(timeout: 2)

      assert_equal :spawn_failed, result.status
      assert_instance_of Errno::ENOENT, result.error
      refute File.exist?(marker)
    end
  end

  def test_arguments_environment_and_directory_remain_literal
    with_literal_executable do |executable, directory, receipt|
      arguments = ["space argument", "semi;colon", "$(printf injected)", "*"]
      job = @supervisor.start(id: "literal-arguments", command: [executable, *arguments],
        environment: {"TYPEFERRY_TEST_RECEIPT" => receipt, "TYPEFERRY_TEST_VALUE" => "literal value"},
        directory: directory, unset_environment: true)

      assert job.wait(timeout: 2).success?

      observed = JSON.parse(File.read(receipt))

      assert_equal arguments, observed.fetch("arguments")
      assert_equal "literal value", observed.fetch("environment")
      assert_equal File.realpath(directory), observed.fetch("directory")
    end
  end

  def test_cancel_is_idempotent_and_terminates_the_process
    job = @supervisor.start(id: "cancel", command: [RbConfig.ruby, "-e", "sleep 30"])

    assert job.cancel
    assert job.cancel
    result = job.wait(timeout: 2)

    assert_equal :canceled, result.status
    refute result.success?
  end

  def test_timeout_terminates_the_process
    job = @supervisor.start(id: "timeout", command: [RbConfig.ruby, "-e", "sleep 30"], timeout: 0.02)

    result = job.wait(timeout: 2)

    assert_equal :timed_out, result.status
  end

  def test_cancel_terminates_descendants_in_the_child_process_group
    Tempfile.create("typeferry-descendant") do |file|
      script = <<~RUBY
        child = Process.spawn(#{RbConfig.ruby.inspect}, "-e", "sleep 30")
        File.write(ARGV.fetch(0), child.to_s)
        sleep 30
      RUBY
      job = @supervisor.start(id: "tree", command: [RbConfig.ruby, "-e", script, file.path])
      descendant_pid = wait_for_pid(file.path)

      job.cancel
      assert_equal :canceled, job.wait(timeout: 2).status

      assert_raises(Errno::ESRCH) { Process.kill(0, descendant_pid) }
    end
  end

  def test_duplicate_active_ids_are_rejected
    @supervisor.start(id: "same", command: [RbConfig.ruby, "-e", "sleep 30"])

    error = assert_raises(ArgumentError) do
      @supervisor.start(id: "same", command: [RbConfig.ruby, "-e", "exit 0"])
    end

    assert_equal "process job 'same' is already active", error.message
  end

  def test_close_cancels_and_joins_active_jobs
    job = @supervisor.start(id: "shutdown", command: [RbConfig.ruby, "-e", "sleep 30"])

    assert @supervisor.close

    assert_equal :canceled, job.result.status
    assert_raises(TypeFerry::ProcessSupervisor::ClosedError) do
      @supervisor.start(id: "late", command: [RbConfig.ruby, "-e", "exit 0"])
    end
  end

  private

  def with_literal_executable
    Dir.mktmpdir("typeferry process ") do |directory|
      executable = File.join(directory, "literal ; process")
      receipt = File.join(directory, "receipt.json")

      File.write(executable, <<~RUBY)
        #!#{RbConfig.ruby}
        require "json"

        File.write(ENV.fetch("TYPEFERRY_TEST_RECEIPT"), JSON.generate({
          arguments: ARGV,
          environment: ENV["TYPEFERRY_TEST_VALUE"],
          directory: Dir.pwd
        }))
      RUBY
      File.chmod(0o700, executable)

      yield executable, directory, receipt
    end
  end

  def wait_for_pid(path)
    Timeout.timeout(2) do
      loop do
        value = File.read(path)
        return Integer(value) unless value.empty?

        sleep 0.005
      end
    end
  end
end
