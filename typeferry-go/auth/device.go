package auth

import (
	"regexp"
	"strings"
)

var (
	iosPhone  = regexp.MustCompile(`iPhone.*OS ([\d_]+)`)
	iosTablet = regexp.MustCompile(`iPad.*OS ([\d_]+)`)
	android   = regexp.MustCompile(`Android ([\d.]+)`)
	windows   = regexp.MustCompile(`Windows NT ([\d.]+)`)
	macOS     = regexp.MustCompile(`Mac OS X ([\d_]+)`)
	chrome    = regexp.MustCompile(`(?:Chrome|CriOS)/([\d.]+)`)
	edge      = regexp.MustCompile(`Edg/([\d.]+)`)
	firefox   = regexp.MustCompile(`Firefox/([\d.]+)`)
	safari    = regexp.MustCompile(`Version/([\d.]+).*Safari/`)
)

func ParseDeviceInfo(headers map[string]string, remoteAddress string) DeviceInfo {
	info := DeviceInfo{IP: remoteAddress}
	for name, value := range headers {
		if strings.ToLower(name) == "user-agent" {
			if len(value) > 512 {
				value = value[:512]
			}
			info.UserAgent = value
		}
	}
	if info.UserAgent == "" {
		return info
	}
	agent := info.UserAgent
	switch {
	case iosPhone.MatchString(agent):
		info.OS = "iOS " + strings.ReplaceAll(capture(iosPhone, agent), "_", ".")
		info.DeviceType = "mobile"
		info.Browser = mobileSafari(agent)
	case iosTablet.MatchString(agent):
		info.OS = "iOS " + strings.ReplaceAll(capture(iosTablet, agent), "_", ".")
		info.DeviceType = "tablet"
		info.Browser = mobileSafari(agent)
	case android.MatchString(agent):
		info.OS = "Android " + capture(android, agent)
		info.DeviceType = "tablet"
		if strings.Contains(agent, "Mobile") {
			info.DeviceType = "mobile"
		}
		if version := capture(chrome, agent); version != "" {
			info.Browser = "Chrome " + version
		}
	case windows.MatchString(agent):
		info.OS = "Windows " + capture(windows, agent)
		info.DeviceType = "desktop"
		info.Browser = desktopBrowser(agent)
	case macOS.MatchString(agent):
		info.OS = "macOS " + strings.ReplaceAll(capture(macOS, agent), "_", ".")
		info.DeviceType = "desktop"
		info.Browser = desktopBrowser(agent)
	default:
		info.DeviceType = "desktop"
		info.Browser = desktopBrowser(agent)
	}
	return info
}

func capture(pattern *regexp.Regexp, value string) string {
	match := pattern.FindStringSubmatch(value)
	if len(match) < 2 {
		return ""
	}
	return match[1]
}

func mobileSafari(agent string) string {
	if version := capture(safari, agent); version != "" {
		return "Mobile Safari " + version
	}
	return "Mobile Safari"
}

func desktopBrowser(agent string) string {
	for _, entry := range []struct {
		pattern *regexp.Regexp
		name    string
	}{
		{edge, "Edge"}, {chrome, "Chrome"}, {firefox, "Firefox"}, {safari, "Safari"},
	} {
		if version := capture(entry.pattern, agent); version != "" {
			return entry.name + " " + version
		}
	}
	return ""
}
