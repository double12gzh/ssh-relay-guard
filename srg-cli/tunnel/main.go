package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

type Status struct {
	State string `json:"state"`
	Port  int    `json:"port"`
	Error string `json:"error,omitempty"`
}

func writeStatus(file string, s Status) {
	if file == "" {
		return
	}
	b, err := json.Marshal(s)
	if err != nil {
		log.Printf("Failed to marshal status: %v", err)
		return
	}
	err = os.WriteFile(file, b, 0644)
	if err != nil {
		log.Printf("Failed to write status file: %v", err)
	}
}

func main() {
	localPort := flag.Int("local-port", 7890, "Local proxy port")
	remotePort := flag.Int("remote-port", 7890, "Desired remote proxy port")
	host := flag.String("host", "", "SSH hostname as defined in ~/.ssh/config")
	statusFile := flag.String("status-file", "", "Path to write JSON status updates")
	logFile := flag.String("log-file", "", "Path to write log output")
	maxRetries := flag.Int("max-retries", 10, "Maximum number of ports to attempt if binding fails")
	flag.Parse()

	if *logFile != "" {
		f, err := os.OpenFile(*logFile, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0666)
		if err == nil {
			log.SetOutput(f)
			defer f.Close()
		}
	}

	if *host == "" {
		log.Fatalf("-host is required")
	}

	log.Printf("Starting srg-tunnel-client for host: %s, target port: %d", *host, *remotePort)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	var cmd *exec.Cmd

	go func() {
		s := <-sigChan
		log.Printf("Received signal %v, shutting down...", s)
		writeStatus(*statusFile, Status{State: "disconnected", Port: 0, Error: "Shutting down"})
		if cmd != nil && cmd.Process != nil {
			// Graceful shutdown: SIGTERM first to let SSH close the remote session
			// and release the forwarded port cleanly.
			cmd.Process.Signal(syscall.SIGTERM)

			// Wait up to 3 seconds for clean exit
			done := make(chan struct{})
			go func() {
				cmd.Wait()
				close(done)
			}()

			select {
			case <-done:
				log.Printf("SSH process exited cleanly")
			case <-time.After(3 * time.Second):
				log.Printf("SSH process did not exit in 3s, sending SIGKILL")
				cmd.Process.Kill()
			}
		}
		os.Exit(0)
	}()

	currentRemotePort := *remotePort
	maxPort := *remotePort + *maxRetries
	hasConnectedOnce := false

	for {
		connState := "connecting"
		if hasConnectedOnce {
			connState = "reconnecting"
		}
		log.Printf("Attempting SSH connection. RemoteForward: %d:127.0.0.1:%d", currentRemotePort, *localPort)
		writeStatus(*statusFile, Status{State: connState, Port: currentRemotePort})

		args := []string{
			"-N",
			"-R", fmt.Sprintf("%d:127.0.0.1:%d", currentRemotePort, *localPort),
			"-o", "BatchMode=yes",
			"-o", "ExitOnForwardFailure=yes",
			"-o", "ServerAliveInterval=30",
			"-o", "ServerAliveCountMax=3",
			"-o", "ConnectTimeout=15",
			"-o", "ControlPath=none", // Completely bypass multiplexing for absolute stability
			*host,
		}

		cmd = exec.Command("ssh", args...)
		
		stderr, err := cmd.StderrPipe()
		if err != nil {
			log.Printf("Failed to create stderr pipe: %v", err)
			time.Sleep(5 * time.Second)
			continue
		}

		if err := cmd.Start(); err != nil {
			log.Printf("Failed to start ssh process: %v", err)
			writeStatus(*statusFile, Status{State: "error", Port: currentRemotePort, Error: err.Error()})
			time.Sleep(5 * time.Second)
			continue
		}

		var portForwardFailure bool
		var pffMu sync.Mutex

		// Channel to signal stderr goroutine completion
		stderrDone := make(chan struct{})

		// Read stderr line by line
		go func() {
			defer close(stderrDone)
			scanner := bufio.NewScanner(stderr)
			for scanner.Scan() {
				line := scanner.Text()
				log.Printf("[ssh] %s", line)
				
				if strings.Contains(strings.ToLower(line), "port forwarding failed") || 
				   strings.Contains(strings.ToLower(line), "forwarding failed") {
					pffMu.Lock()
					portForwardFailure = true
					pffMu.Unlock()
				}
			}
		}()

		// Channel to signal SSH exit
		exitChan := make(chan error, 1)
		go func() {
			exitChan <- cmd.Wait()
		}()

		// Assume connection is stable if it doesn't exit within 8 seconds
		// SSH usually fails much faster if the port is bound or network is unreachable.
		successTimer := time.NewTimer(8 * time.Second)

		select {
		case err := <-exitChan:
			successTimer.Stop()
			log.Printf("SSH process exited prematurely: %v", err)

			// Wait for stderr goroutine to finish draining so we don't miss
			// "port forwarding failed" in the last line of output.
			select {
			case <-stderrDone:
			case <-time.After(500 * time.Millisecond):
				log.Printf("Warning: stderr goroutine did not finish within 500ms")
			}
			
			// Try to determine if it's a port binding issue. Exit code 255 typically indicates this
			// when ExitOnForwardFailure=yes is set.
			isPortBindingError := false
			if exitErr, ok := err.(*exec.ExitError); ok {
				if exitErr.ExitCode() == 255 {
					pffMu.Lock()
					isPortBindingError = portForwardFailure
					pffMu.Unlock()
				}
			}

			// If it's a port binding error, we increment the port to find a free one.
			if isPortBindingError {
				if currentRemotePort < maxPort {
					currentRemotePort++
					log.Printf("Port binding likely failed. Incrementing remote port to %d and retrying...", currentRemotePort)
					writeStatus(*statusFile, Status{State: "retrying", Port: currentRemotePort, Error: "Port binding failed"})
				} else {
					log.Printf("Exhausted all %d port retries. Resetting to base port %d.", *maxRetries, *remotePort)
					currentRemotePort = *remotePort
					writeStatus(*statusFile, Status{State: "error", Port: currentRemotePort, Error: "Max port retries exhausted"})
					// We might want to wait longer here or break, but we'll keep retrying base port
					time.Sleep(10 * time.Second)
				}
			} else {
				// Network error, authentication error, etc. Do not increment port.
				log.Printf("Network or authentication error. Retrying same port %d...", currentRemotePort)
				writeStatus(*statusFile, Status{State: "retrying", Port: currentRemotePort, Error: "SSH connection failed"})
			}
			
			// Backoff before retry
			time.Sleep(3 * time.Second)

		case <-successTimer.C:
			log.Printf("SSH tunnel successfully established on port %d!", currentRemotePort)
			hasConnectedOnce = true
			writeStatus(*statusFile, Status{State: "connected", Port: currentRemotePort})

			// Now wait indefinitely until the connection drops
			err := <-exitChan
			log.Printf("SSH connection dropped: %v. Reconnecting...", err)
			
			// If a previously stable connection drops, we DO NOT increment the port immediately.
			// It's likely a network issue, and the same port is probably still what we want to claim.
			writeStatus(*statusFile, Status{State: "reconnecting", Port: currentRemotePort, Error: "Connection dropped"})
			time.Sleep(3 * time.Second)
		}
	}
}
