# Events and Channels

Events notify connected clients that something happened. Channels scope delivery; durable application state should still come from an RPC read or database.

## Register and emit

```ts
// server/events.ts
import type { Server } from 'typeferry/server'

export const MESSAGE_CHANGED = 'messages:changed'

export function configureEvents(server: Server): void {
  server.addEvent(MESSAGE_CHANGED, { user: true })
}

export function announceMessageChange(
  server: Server,
  ownerId: string,
): void {
  server.channel(ownerId).emit(MESSAGE_CHANGED, { ownerId })
}
```

Use a shared constant for each event name. A private channel name should derive from authenticated server state, not untrusted request data. Configure `shouldSubscribe` or equivalent authorization so clients cannot join another user's channel.

Event options can enforce authenticated use, control subscription, exclude the originator, and enable cluster propagation. Redis transport is appropriate when multiple server processes must fan out the same event.

## Recheck access before delivery

Resource permissions can change while a socket stays connected. Opt in to
delivery checks when a subscription must not outlive that permission:

```ts
server.addEvent(RESOURCE_CHANGED, {
  protected: true,
  cluster: true,
  revalidateOnDelivery: true,
  shouldSubscribe: async (client, _event, resourceId) =>
    canReadResource(client.userId, resourceId),
})
```

`RESOURCE_CHANGED` and `canReadResource` are application-owned. The predicate
must read current authoritative access; the framework does not cache decisions.
Each receiving instance rechecks authentication, channel authorization and
`shouldSubscribe`, including events received through Redis. Denial or a predicate
error suppresses that delivery and removes only that event/channel membership.
Other subscriptions stay connected. A client must subscribe again after access
is restored; the framework does not send an unsolicited subscription response.

Checks are asynchronous and preserve FIFO order within each opted-in membership;
a slow check delays later events for that recipient, without blocking other
recipients. Keep application checks bounded. Unsubscribe, disconnect or leave
and rejoin invalidates pending delivery. Checks begun after committed revocation
must deny access; a frame already authorized before revocation cannot be recalled.
An excluded originator is skipped before checking access.

The option defaults to false and is a TypeScript server capability. Existing
events keep their synchronous broadcast path; wire envelopes and client APIs
are unchanged.

On React, `useRemoteEvent` can handle an event directly, while `useMethod` can associate an event/channel with a refetch. Prefer invalidation plus authoritative refetch over treating an event payload as a durable replica.

See the template's [`messages` server methods](../../template/server/methods/messages.ts) and [React guide](react.md).
