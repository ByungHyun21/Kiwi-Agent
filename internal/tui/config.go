package tui

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
)

// config is the persisted client preference file.
type config struct {
	Language string `json:"language"`
	Server   string `json:"server,omitempty"` // host:port
	Token    string `json:"token,omitempty"`
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "kiwi", "config.json"), nil
}

// loadConfig reads stored preferences, falling back to defaults.
func loadConfig() config {
	cfg := readConfigFile()
	if !validLang(Lang(cfg.Language)) {
		cfg.Language = string(defaultLang)
	}
	return cfg
}

func readConfigFile() config {
	var cfg config
	path, err := configPath()
	if err != nil {
		return cfg
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	json.Unmarshal(data, &cfg)
	return cfg
}

// saveConfig persists preferences, creating the config directory.
func saveConfig(cfg config) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// loadLang reads the stored language, falling back to the default.
func loadLang() Lang {
	return Lang(loadConfig().Language)
}

// saveLang persists the language preference.
func saveLang(l Lang) error {
	cfg := loadConfig()
	cfg.Language = string(l)
	return saveConfig(cfg)
}

// saveServer persists the server address and token.
func saveServer(addr, token string) error {
	cfg := loadConfig()
	cfg.Server = addr
	cfg.Token = token
	return saveConfig(cfg)
}

// configExists reports whether a preference file is present (test helper).
func configExists() bool {
	path, err := configPath()
	if err != nil {
		return false
	}
	_, err = os.Stat(path)
	return !errors.Is(err, fs.ErrNotExist)
}
