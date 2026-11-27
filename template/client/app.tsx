import {
  useAuth,
  useClient,
  useConnectionState,
  useRemoteEvent,
} from 'typeferry/react'
import type { FormEvent, JSX } from 'react'
import { useCallback, useEffect, useState } from 'react'

import type { Message } from '@/common/messages'
import { MESSAGES_CHANGED_EVENT } from '@/common/messages'
import type { MessageApi } from '@/server/methods/messages'

function getOwnerChannel(context: Record<string, unknown>): string {
  const user = context['user']
  if (typeof user !== 'object' || user === null || !('_id' in user)) return ''
  return typeof user._id === 'string' ? user._id : ''
}

export function App(): JSX.Element {
  const client = useClient<MessageApi>()
  const { authenticated } = useAuth()
  const { isOnline } = useConnectionState()
  const [messages, setMessages] = useState<readonly Message[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const ownerChannel = client ? getOwnerChannel(client.context) : ''

  const refresh = useCallback(async (): Promise<void> => {
    if (!authenticated || !client) return

    setIsLoading(true)
    try {
      setMessages(await client.m.messages.list())
      setError(null)
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to load messages',
      )
    } finally {
      setIsLoading(false)
    }
  }, [authenticated, client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useRemoteEvent(
    {
      event: MESSAGES_CHANGED_EVENT,
      channel: ownerChannel,
      active: authenticated && ownerChannel.length > 0,
    },
    () => void refresh(),
    [refresh],
  )

  const createMessage = async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault()
    const nextText = text.trim()
    if (!client || !nextText || isSaving) return

    setIsSaving(true)
    try {
      await client.m.messages.create({ text: nextText })
      setText('')
      setError(null)
    } catch (cause: unknown) {
      setError(
        cause instanceof Error ? cause.message : 'Unable to create message',
      )
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-start bg-slate-100 px-4 py-12 text-slate-900">
      <section
        className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl shadow-slate-900/10 sm:p-8"
        aria-labelledby="page-title"
      >
        <header className="flex flex-col items-stretch justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <p className="text-xs font-bold tracking-[0.12em] text-slate-600 uppercase">
              TypeFerry starter
            </p>
            <h1
              className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl"
              id="page-title"
            >
              Real-time messages
            </h1>
          </div>
          <span
            className={`self-start rounded-full px-3 py-1.5 text-xs font-bold ${
              isOnline
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}
            data-online={isOnline}
          >
            {isOnline ? 'Connected' : 'Connecting'}
          </span>
        </header>

        <form
          className="my-8 grid gap-2"
          onSubmit={event => void createMessage(event)}
        >
          <label className="font-bold" htmlFor="message">
            New message
          </label>
          <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-center">
            <input
              className="min-w-0 flex-1 rounded-lg border border-slate-400 px-3.5 py-3 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
              id="message"
              maxLength={280}
              onChange={event => setText(event.currentTarget.value)}
              placeholder="Write something…"
              value={text}
            />
            <button
              className="cursor-pointer rounded-lg bg-blue-700 px-5 py-3 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!client || !text.trim() || isSaving}
              type="submit"
            >
              {isSaving ? 'Saving…' : 'Send'}
            </button>
          </div>
        </form>

        {error ? <p role="alert">{error}</p> : null}
        {isLoading ? (
          <p className="text-sm text-slate-600">Loading messages…</p>
        ) : null}
        {!isLoading && messages.length === 0 ? (
          <p className="text-sm text-slate-600">
            No messages yet. Create the first one.
          </p>
        ) : null}
        <ol className="grid list-none gap-3 p-0" aria-live="polite">
          {messages.map(message => (
            <li
              className="rounded-xl border border-slate-200 p-4"
              key={message.id}
            >
              <p className="mb-1">{message.text}</p>
              <time
                className="text-sm text-slate-600"
                dateTime={message.createdAt}
              >
                {new Intl.DateTimeFormat('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(message.createdAt))}
              </time>
            </li>
          ))}
        </ol>
      </section>
    </main>
  )
}
