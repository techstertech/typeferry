package auth

import (
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type CookieOptions struct {
	Name       string
	MaxAgeDays int
	Secure     *bool
	SameSite   string
	Path       string
}

func (options CookieOptions) resolved(production bool) (bool, string, string) {
	secure := production
	if options.Secure != nil {
		secure = *options.Secure
	}
	sameSite := options.SameSite
	if sameSite == "" {
		sameSite = "Lax"
	}
	path := options.Path
	if path == "" {
		path = "/"
	}
	return secure, sameSite, path
}

// SetRefreshTokenCookie formats the refresh token as a Set-Cookie header value.
func SetRefreshTokenCookie(token string, options CookieOptions, production bool) string {
	secure, sameSite, path := options.resolved(production)
	parts := []string{options.Name + "=" + encodeCookie(token), "HttpOnly", "Path=" + path,
		"Max-Age=" + strconv.Itoa(options.MaxAgeDays*86400), "SameSite=" + sameSite}
	if secure {
		parts = append(parts, "Secure")
	}
	return strings.Join(parts, "; ")
}

func ClearRefreshTokenCookie(options CookieOptions, production bool) string {
	secure, sameSite, path := options.resolved(production)
	parts := []string{options.Name + "=", "HttpOnly", "Path=" + path, "Max-Age=0", "SameSite=" + sameSite}
	if secure {
		parts = append(parts, "Secure")
	}
	return strings.Join(parts, "; ")
}

func RefreshTokenFromCookieHeader(header, name string) string {
	request := &http.Request{Header: http.Header{"Cookie": {header}}}
	cookie, err := request.Cookie(name)
	if err != nil {
		return ""
	}
	value, err := url.QueryUnescape(strings.ReplaceAll(cookie.Value, "+", "%2B"))
	if err != nil {
		return ""
	}
	return value
}

func encodeCookie(value string) string {
	var result strings.Builder
	for _, byteValue := range []byte(value) {
		if byteValue >= 'A' && byteValue <= 'Z' || byteValue >= 'a' && byteValue <= 'z' ||
			byteValue >= '0' && byteValue <= '9' || strings.ContainsRune("!'()*._~-", rune(byteValue)) {
			result.WriteByte(byteValue)
		} else {
			result.WriteByte('%')
			hex := "0123456789ABCDEF"
			result.WriteByte(hex[byteValue>>4])
			result.WriteByte(hex[byteValue&15])
		}
	}
	return result.String()
}
