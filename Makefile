# Makefile for vibe-kanban-indie
#
# Builds and installs the MCP server binary so it can be registered with
# Claude Code as an MCP server.
#
# Binary names (see local-build.sh):
#   vibe-kanban-mcp  -> the MCP server Claude talks to over stdio   (crate: mcp)
#   vibe-kanban      -> the main backend/web server it connects to  (crate: server)
#
# `vibe-kanban-mcp` is a thin stdio front-end: it needs a running `vibe-kanban`
# backend, located via VIBE_BACKEND_URL, MCP_HOST/MCP_PORT, or the port file
# written by the running server.

CARGO            ?= cargo
PREFIX           ?= $(HOME)/.local
BINDIR           ?= $(PREFIX)/bin
CARGO_TARGET_DIR ?= target
RELEASE_DIR      := $(CARGO_TARGET_DIR)/release

MCP_BIN          := vibe-kanban-mcp
SERVER_BIN       := server            # cargo binary name; installed as `vibe-kanban`
INSTALLED_SERVER := vibe-kanban

# Name to register the MCP server under in Claude.
MCP_NAME         ?= vibe-kanban
# MCP launch mode: global | orchestrator
MCP_MODE         ?= global

.DEFAULT_GOAL := help

.PHONY: help install install-server install-all build build-mcp build-server \
        mcp-register mcp-unregister uninstall clean

help: ## Show this help
	@echo "vibe-kanban-indie Makefile"
	@echo
	@echo "Targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| sed -E 's/^([a-zA-Z0-9_-]+):.*## /  \1\t/' \
		| expand -t20
	@echo
	@echo "Variables (override on the command line):"
	@echo "  PREFIX=$(PREFIX)            install root (binaries go to PREFIX/bin)"
	@echo "  BINDIR=$(BINDIR)"
	@echo "  MCP_NAME=$(MCP_NAME)        name used by 'make mcp-register'"
	@echo "  MCP_MODE=$(MCP_MODE)        global | orchestrator"

build-mcp: ## Build the MCP server binary (release)
	$(CARGO) build --release --bin $(MCP_BIN)

build-server: ## Build the main vibe-kanban backend (release)
	$(CARGO) build --release --bin $(SERVER_BIN)

build: build-mcp build-server ## Build both MCP and backend binaries

install: build-mcp ## Build + install vibe-kanban-mcp into BINDIR
	@mkdir -p "$(BINDIR)"
	install -m 0755 "$(RELEASE_DIR)/$(MCP_BIN)" "$(BINDIR)/$(MCP_BIN)"
	@echo
	@echo "Installed $(BINDIR)/$(MCP_BIN)"
	@echo "Register it with Claude:"
	@echo "  claude mcp add $(MCP_NAME) -- $(BINDIR)/$(MCP_BIN) --mode $(MCP_MODE)"
	@echo "(or run: make mcp-register)"
	@case ":$$PATH:" in *":$(BINDIR):"*) ;; \
		*) echo; echo "NOTE: $(BINDIR) is not on your PATH." ;; esac

install-server: build-server ## Build + install the backend as 'vibe-kanban'
	@mkdir -p "$(BINDIR)"
	install -m 0755 "$(RELEASE_DIR)/$(SERVER_BIN)" "$(BINDIR)/$(INSTALLED_SERVER)"
	@echo "Installed $(BINDIR)/$(INSTALLED_SERVER)"

install-all: install install-server ## Install both the MCP server and the backend

mcp-register: install ## Install, then register the MCP server with Claude Code
	claude mcp add $(MCP_NAME) -- "$(BINDIR)/$(MCP_BIN)" --mode $(MCP_MODE)

mcp-unregister: ## Remove the MCP server registration from Claude Code
	-claude mcp remove $(MCP_NAME)

uninstall: ## Remove installed binaries from BINDIR
	rm -f "$(BINDIR)/$(MCP_BIN)" "$(BINDIR)/$(INSTALLED_SERVER)"

clean: ## cargo clean
	$(CARGO) clean
