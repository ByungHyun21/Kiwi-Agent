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
}

func configPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "kiwi", "config.json"), nil
}

// loadLang reads the stored language, falling back to the default.
func loadLang() Lang {
	path, err := configPath()
	if err != nil {
		return defaultLang
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return defaultLang
	}
	var cfg config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return defaultLang
	}
	lang := Lang(cfg.Language)
	if !validLang(lang) {
		return defaultLang
	}
	return lang
}

// saveLang persists the language preference, creating the config directory.
func saveLang(l Lang) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(config{Language: string(l)}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
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
