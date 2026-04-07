#!/bin/bash
set -e

# Ardour macOS Build Script (Apple Silicon)
# Usage: ./build_ardour.sh [configure|build|clean|deps|all]
# Default: all (deps + configure + build)

JOBS=$(sysctl -n hw.ncpu)
ARDOUR_DIR="$(cd "$(dirname "$0")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[BUILD]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# ──────────────────────────────────────────────
# Dependencies
# ──────────────────────────────────────────────
install_deps() {
    log "Installing dependencies via Homebrew..."

    # Core build tools
    brew install pkg-config python@3

    # Required libraries (from wscript check_pkg calls)
    brew install \
        glib \
        glibmm \
        libsndfile \
        libarchive \
        liblo \
        taglib \
        vamp-plugin-sdk \
        rubberband \
        boost \
        libusb \
        aubio

    # LV2 plugin ecosystem
    brew install \
        lv2 \
        serd \
        sord \
        sratom \
        lilv \
        suil \
        lrdf

    # GTK stack (needed for full build including GUI)
    brew install \
        gtk+ \
        gtkmm \
        cairomm \
        pangomm \
        atkmm

    # Audio backends
    # CoreAudio is built-in on macOS, no install needed
    # JACK is optional:
    # brew install jack

    # Additional tools/libs
    brew install \
        fftw \
        libxml2 \
        readline \
        gettext \
        libwebsockets \
        cppunit

    log "Dependencies installed."

    # Verify critical deps are findable via pkg-config
    log "Verifying pkg-config can find key dependencies..."
    local missing=0
    for pkg in glib-2.0 glibmm-2.4 sndfile liblo taglib vamp-sdk vamp-hostsdk rubberband giomm-2.4; do
        if pkg-config --exists "$pkg" 2>/dev/null; then
            echo "  $(printf '%-20s' "$pkg") $(pkg-config --modversion "$pkg")"
        else
            warn "  $pkg NOT FOUND via pkg-config"
            missing=1
        fi
    done

    # libarchive from brew is keg-only, needs explicit pkg-config path
    if ! pkg-config --exists libarchive 2>/dev/null; then
        ARCHIVEPATH="$(brew --prefix libarchive)/lib/pkgconfig"
        if [ -d "$ARCHIVEPATH" ]; then
            warn "libarchive is keg-only. Adding to PKG_CONFIG_PATH."
            export PKG_CONFIG_PATH="$ARCHIVEPATH:${PKG_CONFIG_PATH:-}"
            echo ""
            echo "  Add this to your shell profile:"
            echo "    export PKG_CONFIG_PATH=\"$ARCHIVEPATH:\$PKG_CONFIG_PATH\""
            echo ""
        fi
    fi

    # libcurl from brew may also be keg-only
    if ! pkg-config --exists libcurl 2>/dev/null; then
        CURLPATH="$(brew --prefix curl)/lib/pkgconfig"
        if [ -d "$CURLPATH" ]; then
            warn "libcurl is keg-only. Adding to PKG_CONFIG_PATH."
            export PKG_CONFIG_PATH="$CURLPATH:${PKG_CONFIG_PATH:-}"
        fi
    fi

    if [ "$missing" -eq 1 ]; then
        warn "Some packages not found. You may need to adjust PKG_CONFIG_PATH."
    fi
}

# ──────────────────────────────────────────────
# Setup PKG_CONFIG_PATH for keg-only formulae
# ──────────────────────────────────────────────
setup_pkg_config() {
    # waf uses #!/usr/bin/env python — ensure python3 is aliased
    if ! command -v python &>/dev/null && command -v python3 &>/dev/null; then
        local pydir="$ARDOUR_DIR/build/pybin"
        mkdir -p "$pydir"
        ln -sf "$(command -v python3)" "$pydir/python"
        export PATH="$pydir:$PATH"
    fi

    local extra_paths=""

    # Keg-only formulae that Ardour needs
    for formula in libarchive curl libxml2 readline gettext icu4c; do
        local prefix
        prefix="$(brew --prefix "$formula" 2>/dev/null)" || continue
        if [ -d "$prefix/lib/pkgconfig" ]; then
            extra_paths="$prefix/lib/pkgconfig:$extra_paths"
        fi
    done

    if [ -n "$extra_paths" ]; then
        export PKG_CONFIG_PATH="${extra_paths}${PKG_CONFIG_PATH:-}"
        log "PKG_CONFIG_PATH set to include keg-only formulae"
    fi
}

# ──────────────────────────────────────────────
# Configure
# ──────────────────────────────────────────────
configure_ardour() {
    log "Configuring Ardour (ARM64 optimized)..."
    cd "$ARDOUR_DIR"

    setup_pkg_config

    # Homebrew on Apple Silicon installs to /opt/homebrew
    local brew_prefix
    brew_prefix="$(brew --prefix)"

    # Collect include/lib paths for keg-only formulae
    local extra_cflags="-I${brew_prefix}/include"
    local extra_ldflags="-L${brew_prefix}/lib"
    # raptor2 headers are in a subdirectory
    local raptor_prefix
    raptor_prefix="$(brew --prefix raptor 2>/dev/null)"
    if [ -d "$raptor_prefix/include/raptor2" ]; then
        extra_cflags="$extra_cflags -I$raptor_prefix/include/raptor2"
    fi

    for formula in libarchive curl libxml2 readline icu4c; do
        local prefix
        prefix="$(brew --prefix "$formula" 2>/dev/null)" || continue
        if [ -d "$prefix/include" ]; then
            extra_cflags="$extra_cflags -I$prefix/include"
        fi
        if [ -d "$prefix/lib" ]; then
            extra_ldflags="$extra_ldflags -L$prefix/lib"
        fi
    done

    CFLAGS="$extra_cflags" \
    CXXFLAGS="$extra_cflags" \
    LDFLAGS="$extra_ldflags" \
    ./waf configure \
        --arm64 \
        --optimize \
        --no-phone-home \
        --with-backends=coreaudio,dummy \
        --boost-include="${brew_prefix}/include" \
        "$@"

    log "Configure complete."
}

# ──────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────
build_ardour() {
    log "Building Ardour with $JOBS parallel jobs..."
    cd "$ARDOUR_DIR"

    setup_pkg_config

    ./waf build -j"$JOBS"

    log "Build complete. Artifacts in: $ARDOUR_DIR/build/"
}

# ──────────────────────────────────────────────
# Clean
# ──────────────────────────────────────────────
clean_ardour() {
    log "Cleaning build artifacts..."
    cd "$ARDOUR_DIR"
    ./waf clean
    log "Clean complete."
}

# ──────────────────────────────────────────────
# Xcode Project
# ──────────────────────────────────────────────
generate_xcode() {
    log "Generating Xcode project..."
    cd "$ARDOUR_DIR"

    setup_pkg_config

    python3 "$ARDOUR_DIR/generate_xcode.py"

    log "Xcode project ready. Open with: open Ardour.xcodeproj"
}

# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────
ACTION="${1:-all}"

case "$ACTION" in
    deps)
        install_deps
        ;;
    configure)
        setup_pkg_config
        shift || true
        configure_ardour "$@"
        ;;
    build)
        build_ardour
        ;;
    clean)
        clean_ardour
        ;;
    xcode)
        generate_xcode
        ;;
    all)
        install_deps
        configure_ardour
        build_ardour
        ;;
    *)
        echo "Usage: $0 [deps|configure|build|clean|xcode|all]"
        echo ""
        echo "  deps       Install Homebrew dependencies"
        echo "  configure  Run waf configure (pass extra flags after)"
        echo "  build      Build Ardour"
        echo "  clean      Clean build artifacts"
        echo "  xcode      Generate Xcode project"
        echo "  all        deps + configure + build (default)"
        exit 1
        ;;
esac
