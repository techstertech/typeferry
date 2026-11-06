import { describe, expect, it } from 'vitest'

import { parseDeviceInfo } from './device-info'

describe('parseDeviceInfo', () => {
  it('returns empty object for null/undefined request', () => {
    expect(parseDeviceInfo(null as any)).toEqual({})
    expect(parseDeviceInfo(undefined as any)).toEqual({})
  })

  it('returns empty object for request with no headers and no ip', () => {
    expect(parseDeviceInfo({})).toEqual({ ip: undefined })
  })

  it('returns ip only when no user-agent header is present', () => {
    const req = {
      socket: { remoteAddress: '10.0.0.1' },
    }
    const result = parseDeviceInfo(req)
    expect(result).toEqual({ ip: '10.0.0.1' })
    expect(result.userAgent).toBeUndefined()
    expect(result.browser).toBeUndefined()
    expect(result.os).toBeUndefined()
    expect(result.deviceType).toBeUndefined()
  })

  it('parses Chrome desktop user agent', () => {
    const req = {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      ip: '1.2.3.4',
    }
    const result = parseDeviceInfo(req)
    expect(result.ip).toBe('1.2.3.4')
    expect(result.userAgent).toBe(req.headers['user-agent'])
    expect(result.browser).toMatch(/^Chrome/)
    expect(result.os).toMatch(/^Windows/)
    expect(result.deviceType).toBe('desktop')
  })

  it('parses mobile user agent and returns deviceType mobile', () => {
    const req = {
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    }
    const result = parseDeviceInfo(req)
    expect(result.deviceType).toBe('mobile')
    expect(result.os).toMatch(/iOS/)
    expect(result.browser).toBeDefined()
  })

  it('parses tablet user agent and returns deviceType tablet', () => {
    const req = {
      headers: {
        'user-agent':
          'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      },
    }
    const result = parseDeviceInfo(req)
    expect(result.deviceType).toBe('tablet')
  })

  it('returns desktop when ua-parser reports no device type', () => {
    const req = {
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    }
    const result = parseDeviceInfo(req)
    // Desktop UAs typically have no device type in ua-parser
    expect(result.deviceType).toBe('desktop')
  })

  it('returns unknown for unrecognized device types', () => {
    // Smarttv or console user agents may map to unknown
    const req = {
      headers: {
        'user-agent':
          'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/5.0 TV Safari/537.36',
      },
    }
    const result = parseDeviceInfo(req)
    // ua-parser may classify this as 'smarttv' which maps to 'unknown'
    expect(['desktop', 'unknown']).toContain(result.deviceType)
  })

  describe('IP extraction priority', () => {
    it('uses the direct socket peer instead of a forwarding header', () => {
      const req = {
        headers: {
          'x-forwarded-for': '203.0.113.1',
          'user-agent': 'TestBot/1.0',
        },
        socket: { remoteAddress: '10.0.0.1' },
        ip: '192.168.1.1',
      }
      const result = parseDeviceInfo(req)
      expect(result.ip).toBe('10.0.0.1')
    })

    it('uses the direct socket peer before an adapter-provided IP', () => {
      const req = {
        headers: {
          'user-agent': 'TestBot/1.0',
        },
        socket: { remoteAddress: '10.0.0.1' },
        ip: '192.168.1.1',
      }
      const result = parseDeviceInfo(req)
      expect(result.ip).toBe('10.0.0.1')
    })

    it('uses an adapter-provided IP without promoting a forwarding header', () => {
      const req = {
        headers: {
          'user-agent': 'TestBot/1.0',
          'x-forwarded-for': '203.0.113.1',
        },
        ip: '192.168.1.1',
      }
      const result = parseDeviceInfo(req)
      expect(result.ip).toBe('192.168.1.1')
    })

    it('returns undefined ip when no ip source is available', () => {
      const req = {
        headers: {
          'user-agent': 'TestBot/1.0',
        },
      }
      const result = parseDeviceInfo(req)
      expect(result.ip).toBeUndefined()
    })
  })

  it('handles user agent with browser name but no version', () => {
    // A minimal user agent that ua-parser may parse with name but no version
    const req = {
      headers: {
        'user-agent': 'CustomBrowser',
      },
    }
    const result = parseDeviceInfo(req)
    // Should not crash; browser may be undefined or a name without version
    expect(result.userAgent).toBe('CustomBrowser')
  })

  it('handles user agent with OS name but no version', () => {
    const req = {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      },
    }
    const result = parseDeviceInfo(req)
    // Should not crash even if OS cannot be determined
    expect(result.userAgent).toBeDefined()
    expect(result.deviceType).toBeDefined()
  })
})
