import { describe, expect, it, vi } from 'vitest'

const verifyIdToken = vi.fn().mockResolvedValue({
  getPayload: () => ({
    sub: 'google-user-1',
    email: 'user@example.com',
    email_verified: true,
  }),
})
const getToken = vi.fn().mockResolvedValue({
  tokens: { id_token: 'id-tok' },
})

vi.mock('google-auth-library', () => ({
  OAuth2Client: class MockOAuth2Client {
    getToken = getToken
    verifyIdToken = verifyIdToken
  },
}))

import { GoogleOAuthProvider } from './google'

describe('GoogleOAuthProvider', () => {
  it('passes configured clientId as audience to verifyIdToken', async () => {
    const provider = new GoogleOAuthProvider({
      clientId: 'client-123.apps.googleusercontent.com',
      clientSecret: 'secret-456',
    })

    const profile = await provider.exchangeCode('auth-code')

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'id-tok',
      audience: 'client-123.apps.googleusercontent.com',
    })
    expect(profile.providerId).toBe('google-user-1')
  })
})
