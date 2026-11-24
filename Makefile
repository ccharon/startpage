# Build and install startpage. Binaries are named bin/startpage-<os>-<arch>[.exe].
#   make                 build the binary for this system
#   make dist            build all release binaries and bin/SHA256SUMS
#   make check           gofmt check, go vet, go test
#   make test-js         unit tests of the frontend helpers (needs Node)
#   make e2e             browser tests against the built binary (needs Node and Chrome)
#   make vulncheck       report known vulnerabilities in the code and the Go standard library
#   make run ARGS=...    build and run with arguments, e.g. ARGS="-addr 127.0.0.1:9000"
#   make install         install the binary for this system as startpage and the systemd user unit,
#                        by default below ~/.local

GO       ?= go
PREFIX   ?= $(HOME)/.local
BINDIR   ?= $(PREFIX)/bin
UNITDIR  ?= $(PREFIX)/share/systemd/user
DESTDIR  ?=
VERSION  ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS  := -s -w -X main.version=$(VERSION)
GOVULNCHECK ?= golang.org/x/vuln/cmd/govulncheck@v1.10.0
HOSTOS   := $(shell $(GO) env GOOS)
HOSTARCH := $(shell $(GO) env GOARCH)
HOSTEXE  := $(if $(filter windows,$(HOSTOS)),.exe,)
NATIVE   := bin/startpage-$(HOSTOS)-$(HOSTARCH)$(HOSTEXE)

# Static binaries without cgo, so they run on any distribution.
# $(1) GOOS, $(2) GOARCH, $(3) output file, $(4) extra linker flags
define gobuild
	CGO_ENABLED=0 GOOS=$(1) GOARCH=$(2) $(GO) build -trimpath -ldflags '$(LDFLAGS) $(4)' -o $(3) ./cmd/startpage
endef

.PHONY: all build dist check test-js e2e vulncheck fmt fmt-check vet test run install uninstall clean \
	linux-amd64 linux-arm64 windows-amd64 windows-amd64-noconsole

all: build

build:
	$(call gobuild,$(HOSTOS),$(HOSTARCH),$(NATIVE))

linux-amd64:
	$(call gobuild,linux,amd64,bin/startpage-linux-amd64)

linux-arm64:
	$(call gobuild,linux,arm64,bin/startpage-linux-arm64)

windows-amd64:
	$(call gobuild,windows,amd64,bin/startpage-windows-amd64.exe)

# Without a console window; it can only be stopped through the task manager.
windows-amd64-noconsole:
	$(call gobuild,windows,amd64,bin/startpage-windows-amd64-noconsole.exe,-H windowsgui)

dist: linux-amd64 linux-arm64 windows-amd64 windows-amd64-noconsole
	cd bin && sha256sum startpage-linux-amd64 startpage-linux-arm64 \
		startpage-windows-amd64.exe startpage-windows-amd64-noconsole.exe > SHA256SUMS

check: fmt-check vet test

test-js:
	node --test web/test/*.test.js

e2e: build
	node web/test/e2e.mjs ./$(NATIVE)

# Needs network access for the tool and the vulnerability database.
vulncheck:
	$(GO) run $(GOVULNCHECK) ./...

fmt:
	gofmt -w .

fmt-check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi

vet:
	$(GO) vet ./...

test:
	$(GO) test ./...

run: build
	./$(NATIVE) $(ARGS)

install: build
	install -Dm755 $(NATIVE) $(DESTDIR)$(BINDIR)/startpage
	sed 's|@BINDIR@|$(BINDIR)|g' init/startpage.service > bin/startpage.service
	install -Dm644 bin/startpage.service $(DESTDIR)$(UNITDIR)/startpage.service

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/startpage $(DESTDIR)$(UNITDIR)/startpage.service

clean:
	rm -rf bin
