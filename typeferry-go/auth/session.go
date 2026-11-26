package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
	"time"
)

type DeviceInfo struct {
	IP         string
	UserAgent  string
	OS         string
	Browser    string
	DeviceType string
}

type Session struct {
	ID         string
	UserID     string
	FamilyID   string
	Token      string
	Expiration time.Time
	DeviceInfo *DeviceInfo
	Revoked    bool
	ReplacedBy string
	UsedAt     time.Time
}

type TokenPair struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
}

type InMemorySessionManager struct {
	mu       sync.Mutex
	config   Config
	now      func() time.Time
	sessions map[string]*Session
}

func NewInMemorySessionManager(config Config, now func() time.Time) (*InMemorySessionManager, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	if now == nil {
		now = time.Now
	}
	return &InMemorySessionManager{config: config, now: now, sessions: make(map[string]*Session)}, nil
}

func (manager *InMemorySessionManager) CreateSession(userID string, device *DeviceInfo) (TokenPair, error) {
	if userID == "" {
		return TokenPair{}, errors.New("user ID is required")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	familyID, err := randomID()
	if err != nil {
		return TokenPair{}, err
	}
	return manager.createLocked(userID, familyID, device)
}

func (manager *InMemorySessionManager) createLocked(userID, familyID string, device *DeviceInfo) (TokenPair, error) {
	if len(manager.sessions) >= 10000 {
		manager.pruneExpiredLocked()
	}
	token, err := randomID()
	if err != nil {
		return TokenPair{}, err
	}
	sessionID, err := randomID()
	if err != nil {
		return TokenPair{}, err
	}
	copyDevice := cloneDevice(device)
	session := &Session{ID: sessionID, UserID: userID, FamilyID: familyID, Token: token, Expiration: manager.now().Add(manager.config.RefreshTokenExpiry), DeviceInfo: copyDevice}
	manager.sessions[token] = session
	return manager.pairLocked(session)
}

func (manager *InMemorySessionManager) pairLocked(session *Session) (TokenPair, error) {
	now := manager.now()
	expiry := now.Add(manager.config.AccessTokenExpiry)
	payload := AccessTokenPayload{UserID: session.UserID, SessionID: session.ID, IssuedAt: now.Unix(), ExpiresAt: expiry.Unix()}
	access, err := SignAccessToken(payload, manager.config)
	if err != nil {
		return TokenPair{}, err
	}
	return TokenPair{AccessToken: access, RefreshToken: session.Token, ExpiresAt: expiry}, nil
}

func (manager *InMemorySessionManager) RefreshSession(token string, device *DeviceInfo) (TokenPair, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	session := manager.sessions[token]
	if session == nil || session.Revoked || manager.now().After(session.Expiration) {
		return TokenPair{}, errors.New("refresh session is unavailable")
	}
	if session.ReplacedBy != "" {
		if session.UsedAt.IsZero() || manager.now().Sub(session.UsedAt) > manager.config.RotationGracePeriod {
			manager.revokeFamilyLocked(session.FamilyID)
			return TokenPair{}, errors.New("refresh token was reused")
		}
		replacement := manager.sessions[session.ReplacedBy]
		if replacement == nil || replacement.Revoked || replacement.ReplacedBy != "" || manager.now().After(replacement.Expiration) {
			manager.revokeFamilyLocked(session.FamilyID)
			return TokenPair{}, errors.New("replacement session is unavailable")
		}
		return manager.pairLocked(replacement)
	}
	pair, err := manager.createLocked(session.UserID, session.FamilyID, device)
	if err != nil {
		return TokenPair{}, err
	}
	session.ReplacedBy = pair.RefreshToken
	session.UsedAt = manager.now()
	return pair, nil
}

func (manager *InMemorySessionManager) RevokeSession(id string) bool {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for _, session := range manager.sessions {
		if session.ID == id {
			session.Revoked = true
			return true
		}
	}
	return false
}

func (manager *InMemorySessionManager) RevokeFamily(id string) int {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.revokeFamilyLocked(id)
}

func (manager *InMemorySessionManager) revokeFamilyLocked(id string) int {
	count := 0
	for _, session := range manager.sessions {
		if session.FamilyID == id && !session.Revoked {
			session.Revoked = true
			count++
		}
	}
	return count
}

func (manager *InMemorySessionManager) UserSessions(userID string) []Session {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	var result []Session
	for _, session := range manager.sessions {
		if session.UserID == userID && !session.Revoked && session.ReplacedBy == "" && manager.now().Before(session.Expiration) {
			copy := *session
			copy.DeviceInfo = cloneDevice(session.DeviceInfo)
			result = append(result, copy)
		}
	}
	return result
}

func (manager *InMemorySessionManager) RevokeAllUserSessions(userID, exceptFamilyID string) int {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	count := 0
	for _, session := range manager.sessions {
		if session.UserID == userID && session.FamilyID != exceptFamilyID && !session.Revoked {
			session.Revoked = true
			count++
		}
	}
	return count
}

func (manager *InMemorySessionManager) SessionFor(token string) (Session, bool) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	session := manager.sessions[token]
	if session == nil {
		return Session{}, false
	}
	copy := *session
	copy.DeviceInfo = cloneDevice(session.DeviceInfo)
	return copy, true
}

func (manager *InMemorySessionManager) Cleanup() int {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	return manager.pruneExpiredLocked()
}

func (manager *InMemorySessionManager) pruneExpiredLocked() int {
	count := 0
	for token, session := range manager.sessions {
		if session.Revoked || !manager.now().Before(session.Expiration) {
			delete(manager.sessions, token)
			count++
		}
	}
	return count
}

func (manager *InMemorySessionManager) Close() {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	clear(manager.sessions)
}

func cloneDevice(device *DeviceInfo) *DeviceInfo {
	if device == nil {
		return nil
	}
	copy := *device
	return &copy
}

func randomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80
	return hex.EncodeToString(raw[0:4]) + "-" + hex.EncodeToString(raw[4:6]) + "-" + hex.EncodeToString(raw[6:8]) + "-" + hex.EncodeToString(raw[8:10]) + "-" + hex.EncodeToString(raw[10:16]), nil
}
