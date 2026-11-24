//go:build !windows

package main

func detachOwnConsole() bool { return false }
