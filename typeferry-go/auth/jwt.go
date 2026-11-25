// Package auth provides TypeFerry-compatible token and session helpers.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"hash"
	"strings"
	"time"
)

type Algorithm string

const (
	HS256 Algorithm = "HS256"
	HS384 Algorithm = "HS384"
	HS512 Algorithm = "HS512"
)

type Config struct {
	Secret              []byte
	Algorithm           Algorithm
	AccessTokenExpiry   time.Duration
	RefreshTokenExpiry  time.Duration
	RotationGracePeriod time.Duration
}

func (config Config) Validate() error {
	if len(config.Secret) == 0 {
		return errors.New("token secret is required")
	}
	if _, err := config.hash(); err != nil {
		return err
	}
	if config.AccessTokenExpiry <= 0 || config.RefreshTokenExpiry <= 0 || config.RotationGracePeriod < 0 {
		return errors.New("token lifetimes are invalid")
	}
	return nil
}

func (config Config) hash() (func() hash.Hash, error) {
	switch config.Algorithm {
	case HS256:
		return sha256.New, nil
	case HS384:
		return sha512.New384, nil
	case HS512:
		return sha512.New, nil
	default:
		return nil, errors.New("token algorithm must be HS256, HS384, or HS512")
	}
}

type AccessTokenPayload struct {
	UserID    string         `json:"userId"`
	SessionID string         `json:"sessionId"`
	IssuedAt  int64          `json:"iat"`
	ExpiresAt int64          `json:"exp"`
	Claims    map[string]any `json:"claims,omitempty"`
}

func SignAccessToken(payload AccessTokenPayload, config Config) (string, error) {
	if err := config.Validate(); err != nil {
		return "", err
	}
	header, err := json.Marshal(map[string]string{"alg": string(config.Algorithm), "typ": "JWT"})
	if err != nil {
		return "", err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	unsigned := base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body)
	hashFactory, _ := config.hash()
	mac := hmac.New(hashFactory, config.Secret)
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

func VerifyAccessToken(token string, config Config, now time.Time) (AccessTokenPayload, error) {
	if err := config.Validate(); err != nil {
		return AccessTokenPayload{}, err
	}
	token = strings.TrimSpace(token)
	if len(token) >= 7 && strings.EqualFold(token[:7], "Bearer ") {
		token = token[7:]
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return AccessTokenPayload{}, errors.New("invalid token")
	}
	headerData, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return AccessTokenPayload{}, err
	}
	var header struct {
		Algorithm string `json:"alg"`
	}
	if err := json.Unmarshal(headerData, &header); err != nil || header.Algorithm != string(config.Algorithm) {
		return AccessTokenPayload{}, errors.New("token algorithm mismatch")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return AccessTokenPayload{}, err
	}
	hashFactory, _ := config.hash()
	mac := hmac.New(hashFactory, config.Secret)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return AccessTokenPayload{}, errors.New("invalid token signature")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return AccessTokenPayload{}, err
	}
	var payload AccessTokenPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		return AccessTokenPayload{}, err
	}
	if payload.UserID == "" || payload.SessionID == "" || payload.IssuedAt == 0 || payload.ExpiresAt == 0 {
		return AccessTokenPayload{}, errors.New("token claims are incomplete")
	}
	seconds := now.Unix()
	if seconds < payload.IssuedAt || seconds >= payload.ExpiresAt || seconds-payload.IssuedAt > int64(config.AccessTokenExpiry.Seconds()) {
		return AccessTokenPayload{}, errors.New("token has expired or is not yet valid")
	}
	return payload, nil
}

// DecodeAccessToken reads unverified claims for diagnostics.
// Never use its output for authorization.
func DecodeAccessToken(token string) (AccessTokenPayload, error) {
	parts := strings.Split(strings.TrimPrefix(token, "Bearer "), ".")
	if len(parts) != 3 {
		return AccessTokenPayload{}, errors.New("invalid token")
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return AccessTokenPayload{}, err
	}
	var payload AccessTokenPayload
	err = json.Unmarshal(body, &payload)
	return payload, err
}
