//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	kernel32                  = syscall.NewLazyDLL("kernel32.dll")
	procGetConsoleProcessList = kernel32.NewProc("GetConsoleProcessList")
	procFreeConsole           = kernel32.NewProc("FreeConsole")
)

// detachOwnConsole releases the console if this process is its only user,
// i.e. it was started by double-click/shortcut and Windows created a console
// just for it. Started from a shell the console is shared and kept, so Ctrl+C works.
func detachOwnConsole() bool {
	if procGetConsoleProcessList.Find() != nil || procFreeConsole.Find() != nil {
		return false
	}
	var pids [2]uint32
	n, _, _ := procGetConsoleProcessList.Call(uintptr(unsafe.Pointer(&pids[0])), uintptr(len(pids)))
	if n != 1 {
		return false
	}
	r, _, _ := procFreeConsole.Call()
	return r != 0
}
