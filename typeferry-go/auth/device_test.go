package auth

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseDeviceInfo(t *testing.T) {
	examples := []struct{ agent, os, browser, kind string }{
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile Safari/604.1", "iOS 17.4", "Mobile Safari 17.4", "mobile"},
		{"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) Chrome/120.0", "macOS 14.2", "Chrome 120.0", "desktop"},
		{"Mozilla/5.0 (Windows NT 10.0) Firefox/122.0", "Windows 10.0", "Firefox 122.0", "desktop"},
	}
	for _, example := range examples {
		result := ParseDeviceInfo(map[string]string{"user-agent": example.agent, "x-forwarded-for": "192.0.2.1"}, "198.51.100.2")
		if result.OS != example.os || result.Browser != example.browser || result.DeviceType != example.kind || result.IP != "198.51.100.2" {
			t.Fatalf("device = %#v", result)
		}
	}

	hugeUA := make([]byte, 2048)
	for i := range hugeUA {
		hugeUA[i] = 'a'
	}
	bounded := ParseDeviceInfo(map[string]string{"user-agent": string(hugeUA)}, "198.51.100.2")
	if len(bounded.UserAgent) > 512 {
		t.Fatalf("UserAgent length = %d, want <= 512", len(bounded.UserAgent))
	}

	multiByteUA := strings.Repeat("é", 300) // 600 bytes (2 bytes per rune) -> slicing byte 511/512 could split rune if misaligned; test with odd offset!
	multiByteOffset := "a" + strings.Repeat("é", 300)
	utf8Safe := ParseDeviceInfo(map[string]string{"user-agent": multiByteOffset}, "198.51.100.2")
	_ = multiByteUA
	if !utf8.ValidString(utf8Safe.UserAgent) {
		t.Fatalf("UserAgent truncated mid-rune: invalid UTF-8")
	}
}
