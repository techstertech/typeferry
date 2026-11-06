# frozen_string_literal: true

require "monitor"

module TypeFerry
  # Immutable terminal state for one supervised child process.
  class ProcessResult
    attr_reader :status, :exit_status, :term_signal, :error

    def initialize(status:, exit_status:, term_signal:, error:)
      @status = status
      @exit_status = exit_status
      @term_signal = term_signal
      @error = error
      freeze
    end

    def success?
      status == :exited && exit_status == 0
    end
  end

  # One child process and its cancellation, timeout, and wait lifecycle.
  class ProcessJob
    attr_reader :id, :pid

    def initialize(supervisor, id:, command:, environment:, directory:, timeout:, stdin:, stdout:, stderr:,
      unset_environment:)
      @supervisor = supervisor
      @id = id
      @command = command
      @environment = environment
      @directory = directory
      @timeout = timeout
      @stdin = stdin
      @stdout = stdout
      @stderr = stderr
      @unset_environment = unset_environment
      @lock = Monitor.new
      @condition = @lock.new_cond
      @cancel_requested = false
      @result = nil
    end

    def start
      # @type var options: Hash[Symbol, untyped]
      options = {pgroup: true, in: @stdin, out: @stdout, err: @stderr, unsetenv_others: @unset_environment}
      options[:chdir] = @directory if @directory
      executable = @command.fetch(0)

      # The executable/argv0 pair prevents Ruby from interpreting singleton
      # commands as shell syntax while preserving literal executable paths.
      @pid = Kernel.spawn(@environment, [executable, executable], *@command.drop(1), **options)
      @started_at = monotonic_now
      @thread = Thread.new { monitor_process }
      @thread.report_on_exception = false
      self
    rescue => exception
      finish(ProcessResult.new(status: :spawn_failed, exit_status: nil, term_signal: nil, error: exception))
      self
    end

    def cancel
      process_id = @lock.synchronize do
        return true if @result

        @cancel_requested = true
        @pid
      end
      @supervisor.signal_process_group(process_id, "TERM") if process_id
      true
    end

    def wait(timeout: nil)
      deadline = timeout && monotonic_now + timeout
      @lock.synchronize do
        until @result
          remaining = deadline && deadline - monotonic_now
          raise ProcessSupervisor::WaitTimeout, "process job '#{id}' did not finish" if remaining && remaining <= 0

          @condition.wait(remaining)
        end
        @result
      end
    end

    def result
      @lock.synchronize { @result }
    end

    def active?
      @lock.synchronize { !@result }
    end

    private

    def monitor_process
      loop do
        if cancel_requested?
          terminate_and_finish(:canceled)
          return
        end
        if timed_out?
          terminate_and_finish(:timed_out)
          return
        end
        if (status = reap(no_hang: true))
          finish(exit_result(status))
          return
        end

        sleep @supervisor.poll_interval
      end
    rescue => exception
      finish(ProcessResult.new(status: :failed, exit_status: nil, term_signal: nil, error: exception))
    end

    def terminate_and_finish(status)
      @supervisor.terminate_process_group(pid)
      process_status = reap(no_hang: false)
      finish(ProcessResult.new(status:, exit_status: process_status&.exitstatus,
        term_signal: process_status&.termsig, error: nil))
    end

    def reap(no_hang:)
      process_id = pid
      raise "process job '#{id}' was not started" unless process_id

      _child, status = Process.waitpid2(process_id, no_hang ? Process::WNOHANG : 0)
      status
    rescue Errno::ECHILD
      nil
    end

    def exit_result(status)
      ProcessResult.new(status: :exited, exit_status: status.exitstatus, term_signal: status.termsig, error: nil)
    end

    def cancel_requested?
      @lock.synchronize { @cancel_requested }
    end

    def timed_out?
      @timeout && monotonic_now - @started_at >= @timeout
    end

    def finish(value)
      completed = @lock.synchronize do
        next false if @result

        @result = value
        @condition.broadcast
        true
      end
      @supervisor.finish(self) if completed
      value
    end

    def monotonic_now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end

  # Runs argv-only child processes in isolated process groups and reaps them.
  class ProcessSupervisor
    class ClosedError < StandardError
    end

    class WaitTimeout < StandardError
    end

    attr_reader :poll_interval, :termination_grace

    def initialize(poll_interval: 0.01, termination_grace: 0.25)
      raise ArgumentError, "poll interval must be positive" unless poll_interval.positive?
      raise ArgumentError, "termination grace must be non-negative" if termination_grace.negative?

      @poll_interval = poll_interval
      @termination_grace = termination_grace
      # @type var jobs: Hash[String, ProcessJob]
      jobs = {}

      @jobs = jobs
      @lock = Monitor.new
      @closed = false
    end

    def start(id:, command:, environment: {}, directory: nil, timeout: nil, stdin: File::NULL, stdout: File::NULL,
      stderr: File::NULL, unset_environment: false)
      validate_start(id, command, timeout)
      job = ProcessJob.new(self, id:, command: command.map(&:to_s).freeze,
        environment: normalize_environment(environment), directory:, timeout:, stdin:, stdout:, stderr:,
        unset_environment:)
      @lock.synchronize do
        raise ClosedError, "process supervisor is closed" if @closed
        raise ArgumentError, "process job '#{id}' is already active" if @jobs.key?(id)

        @jobs[id] = job
      end
      job.start
    end

    def active?(id)
      @lock.synchronize { @jobs.key?(id) }
    end

    def cancel(id)
      @lock.synchronize { @jobs[id] }&.cancel || false
    end

    def close
      jobs = @lock.synchronize do
        return true if @closed

        @closed = true
        @jobs.values
      end
      jobs.each(&:cancel)
      jobs.each(&:wait)
      true
    end

    def finish(job)
      @lock.synchronize { @jobs.delete(job.id) if @jobs[job.id].equal?(job) }
    end

    def signal_process_group(pid, signal)
      Process.kill(signal, -pid)
      true
    rescue Errno::ESRCH, Errno::EPERM
      false
    end

    def terminate_process_group(pid)
      signal_process_group(pid, "TERM")
      sleep termination_grace if termination_grace.positive?
      signal_process_group(pid, "KILL")
      true
    end

    private

    def validate_start(id, command, timeout)
      raise ArgumentError, "process job id is required" unless id.is_a?(String) && !id.empty?
      unless command.is_a?(Array) && !command.empty? && command.all? { |argument| argument.is_a?(String) && !argument.empty? }
        raise ArgumentError, "process command must be a non-empty argv array"
      end
      raise ArgumentError, "process timeout must be positive" if timeout && !timeout.positive?
    end

    def normalize_environment(environment)
      environment.to_h { |name, value| [name.to_s, value.to_s] }.freeze
    end

    def monotonic_now
      Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end
  end
end
