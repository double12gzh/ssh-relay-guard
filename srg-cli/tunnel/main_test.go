package main

import (
	"encoding/json"
	"os"
	"testing"
)

func TestWriteStatus(t *testing.T) {
	tmpFile, err := os.CreateTemp("", "srg-test-status-*.json")
	if err != nil {
		t.Fatalf("Failed to create temp file: %v", err)
	}
	defer os.Remove(tmpFile.Name())

	expectedState := "retrying"
	expectedPort := 7891
	expectedError := "Port binding failed"

	writeStatus(tmpFile.Name(), Status{
		State: expectedState,
		Port:  expectedPort,
		Error: expectedError,
	})

	content, err := os.ReadFile(tmpFile.Name())
	if err != nil {
		t.Fatalf("Failed to read temp file: %v", err)
	}

	var s Status
	if err := json.Unmarshal(content, &s); err != nil {
		t.Fatalf("Failed to unmarshal json: %v", err)
	}

	if s.State != expectedState {
		t.Errorf("Expected state %s, got %s", expectedState, s.State)
	}
	if s.Port != expectedPort {
		t.Errorf("Expected port %d, got %d", expectedPort, s.Port)
	}
	if s.Error != expectedError {
		t.Errorf("Expected error %s, got %s", expectedError, s.Error)
	}
}
