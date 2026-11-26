import { OAuth2Client } from 'google-auth-library'

import type { OAuthProvider, OAuthUserProfile } from './types'

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  /**
   * Redirect URI for the OAuth flow.
   * Defaults to `'postmessage'` for popup-based flows.
   */
  redirectUri?: string
}

/**
 * Google OAuth provider that exchanges authorization codes for
 * verified user profiles via the Google Identity Platform.
 *
 * @example
 * ```ts
 * const google = new GoogleOAuthProvider({
 *   clientId: process.env.GOOGLE_CLIENT_ID,
 *   clientSecret: process.env.GOOGLE_CLIENT_SECRET,
 * })
 *
 * const profile = await google.exchangeCode(code)
 * // → { providerId, provider: 'google', email, name, picture, ... }
 * ```
 */
export class GoogleOAuthProvider implements OAuthProvider {
  readonly name = 'google' as const
  private readonly client: OAuth2Client
  private readonly clientId: string

  constructor(config: GoogleOAuthConfig) {
    this.clientId = config.clientId
    this.client = new OAuth2Client(
      config.clientId,
      config.clientSecret,
      config.redirectUri ?? 'postmessage',
    )
  }

  async exchangeCode(code: string): Promise<OAuthUserProfile> {
    const { tokens } = await this.client.getToken(code)

    if (!tokens.id_token) throw new Error('Google did not return an ID token')

    const ticket = await this.client.verifyIdToken({
      idToken: tokens.id_token,
      audience: this.clientId,
    })

    const payload = ticket.getPayload()

    if (!payload?.sub) throw new Error('Google ID token has no subject')

    return {
      providerId: payload.sub,
      provider: this.name,
      ...(payload.email === undefined ? {} : { email: payload.email }),
      ...(payload.email_verified === undefined
        ? {}
        : { emailVerified: payload.email_verified }),
      ...(payload.name === undefined ? {} : { name: payload.name }),
      ...(payload.picture === undefined ? {} : { picture: payload.picture }),
      raw: payload as unknown as Record<string, unknown>,
    }
  }
}
