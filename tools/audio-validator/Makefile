# Standalone build — does NOT touch the main waf system.
# Usage: make                     → builds ./audio-validator
#        make OUT=/some/where     → overrides output location
#        make clean

CXX       ?= clang++
CXXFLAGS  ?= -std=c++17 -O2 -Wall -Wextra
PKG_CFG   ?= pkg-config
SNDFILE_CFLAGS := $(shell $(PKG_CFG) --cflags sndfile 2>/dev/null)
SNDFILE_LIBS   := $(shell $(PKG_CFG) --libs sndfile 2>/dev/null)

# Homebrew fallback on macOS if pkg-config not configured for sndfile.
ifeq ($(SNDFILE_LIBS),)
  ifeq ($(shell uname),Darwin)
    BREW_PREFIX := $(shell brew --prefix libsndfile 2>/dev/null)
    ifneq ($(BREW_PREFIX),)
      SNDFILE_CFLAGS := -I$(BREW_PREFIX)/include
      SNDFILE_LIBS   := -L$(BREW_PREFIX)/lib -lsndfile
    endif
  endif
endif

OUT ?= audio-validator

$(OUT): main.cc
	$(CXX) $(CXXFLAGS) $(SNDFILE_CFLAGS) -o $@ $< $(SNDFILE_LIBS)

.PHONY: clean
clean:
	rm -f $(OUT)
