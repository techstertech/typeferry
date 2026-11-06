import { UAParser } from 'ua-parser-js'

import type { DeviceInfo } from '../types'

/**
 * Request-like object for extracting device information.
 */
interface RequestLike {
  headers?: {
    'user-agent'?: string
    'x-forwarded-for'?: string
  }
  socket?: { remoteAddress?: string }
  ip?: string
}

/**
 * Parse device information from an HTTP request.
 * Extracts IP address, user agent, browser, OS, and device type.
 *
 * @param req - Request object with headers and socket info
 * @returns Parsed device information
 */
export function parseDeviceInfo(req: RequestLike): DeviceInfo {
  if (!req) {
    return {}
  }

  const uaString = req.headers?.['user-agent']
  const ip = getIpFromRequest(req)

  if (!uaString) {
    return ip === undefined ? {} : { ip }
  }

  const parser = new UAParser(uaString)
  const result = parser.getResult()

  return {
    ...(ip === undefined ? {} : { ip }),
    userAgent: uaString,
    ...(result.browser.name
      ? { browser: `${result.browser.name} ${result.browser.version || ''}`.trim() }
      : {}),
    ...(result.os.name
      ? { os: `${result.os.name} ${result.os.version || ''}`.trim() }
      : {}),
    deviceType: mapDeviceType(result.device.type),
  }
}

/**
 * Extract client IP address from request.
 * Uses the socket address or adapter-provided IP. Forwarding headers are
 * untrusted; proxy identity must be resolved by the host before this boundary.
 */
function getIpFromRequest(req: RequestLike): string | undefined {
  return req.socket?.remoteAddress ?? req.ip
}

/**
 * Map UA parser device type to our DeviceInfo type.
 */
function mapDeviceType(
  type?: string,
): NonNullable<DeviceInfo['deviceType']> {
  if (!type) return 'desktop'
  if (type === 'mobile') return 'mobile'
  if (type === 'tablet') return 'tablet'
  return 'unknown'
}
