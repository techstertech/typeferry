import { expect, it } from 'vitest'

export interface GoContractClient {
  call(method: string, params?: unknown): Promise<unknown>
  close(): Promise<void>
}

/**
 * Both real client transports exercise the same method/value contract. Each
 * case owns its client so authentication and subscriptions cannot bleed across
 * cases; the fixtures remain application declarations over ordinary Go APIs.
 */
export function goMethodContract(createClient: (token?: string) => Promise<GoContractClient>): void {
  async function usingClient(check: (client: GoContractClient) => Promise<void>): Promise<void> {
    const client = await createClient()
    try {
      await check(client)
    } finally {
      await client.close()
    }
  }

  for (const [name, value] of [
    ['date', new Date('2026-09-30T12:34:56.789Z')],
    ['regex', /a+b/imu],
    ['binary', Uint8Array.from({ length: 17 }, (_, index) => (index * 37) % 256)],
    ['nonfinite', { nan: Number.NaN, positive: Number.POSITIVE_INFINITY, negative: Number.NEGATIVE_INFINITY }],
    ['literal tags', { nested: [{ $date: 7 }, { $binary: 'AQI=' }, { $InfNaN: 0 }, { $type: 'literal', $value: { a: 1 } }] }],
  ] as const) {
    it(`round trips ${name} through the Go codec`, async () => {
      await usingClient(async client => {
        expect(await client.call('echo', value)).toEqual(value)
      })
    })
  }

  it('retains public errors and hides internal failures', async () => {
    await usingClient(async client => {
      await expect(client.call('not_registered')).rejects.toMatchObject({ message: 'Method Not Found' })
      await expect(client.call('public_error')).rejects.toMatchObject({ message: 'application rejected this input' })
      await expect(client.call('internal_error')).rejects.toMatchObject({ message: 'Internal Error' })
    })
  })

  it('validates before middleware and returns the transformed parameters', async () => {
    await usingClient(async client => {
      expect(await client.call('validated', { amount: 3, discarded: 'input' })).toEqual({ amount: 6, validated: true })
      for (const params of [undefined, null, {}, { amount: -1 }, { amount: '3' }]) {
        await expect(client.call('validated', params)).rejects.toMatchObject({ message: 'Invalid Params: amount: positive number required' })
      }
    })
  })

  it('shares cached calls while retaining ordinary object key order', async () => {
    await usingClient(async client => {
      const firstParams = { scope: 'shared', a: 1, b: 2 }
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => client.call('cached_counter', firstParams)))
      for (const result of concurrent) expect(result).toEqual(concurrent[0])
      expect(await client.call('cached_counter', firstParams)).toEqual(concurrent[0])
      expect(await client.call('cached_counter', { scope: 'shared', b: 2, a: 1 })).not.toEqual(concurrent[0])
    })
  })

  it('executes authenticated cached calls without reading or replacing anonymous results', async () => {
    const anonymous = await createClient()
    const authenticated = await createClient('good-token')
    const params = { scope: 'authentication-isolation' }

    try {
      const anonymousResult = await anonymous.call('cached_counter', params)
      const firstAuthenticated = await authenticated.call('cached_counter', params)
      const secondAuthenticated = await authenticated.call('cached_counter', params)

      expect(firstAuthenticated).not.toEqual(anonymousResult)
      expect(secondAuthenticated).not.toEqual(firstAuthenticated)
      expect(await anonymous.call('cached_counter', params)).toEqual(anonymousResult)

      const authenticatedFirstParams = { scope: 'authenticated-first' }
      const privateResult = await authenticated.call('cached_counter', authenticatedFirstParams)
      const publicResult = await anonymous.call('cached_counter', authenticatedFirstParams)

      expect(publicResult).not.toEqual(privateResult)
      expect(await anonymous.call('cached_counter', authenticatedFirstParams)).toEqual(publicResult)
    } finally {
      await Promise.all([anonymous.close(), authenticated.close()])
    }
  })
}
